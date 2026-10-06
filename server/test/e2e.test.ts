import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { initSchema, type DB } from '../src/db/database';
import type {
  AuthorMetric,
  AuthorView,
  CommitListItem,
  JobView,
  MetricRow,
  RepoSummary,
  TimelinePoint,
} from '../src/types';

/**
 * End-to-end test: a real git fixture (built below with the git CLI) is
 * ingested through the HTTP API and every metric endpoint is verified against
 * hand-computed expectations.
 *
 * Fixture history (committer dates pinned via GIT_COMMITTER_DATE):
 *
 *   main:    c1 ── c2 ── c3 ── c4 ── m (merge of feature) ── c5   (HEAD)
 *                      └─ feature: cf ────────────┘
 *
 *   c1  Alice         2024-01-01  src/app.js +10, README.md +2,
 *                                  .mailmap +1, logo.png (binary → excluded)
 *   cf  Alice         2024-01-02T docs/feature.md +3               (on feature)
 *   c2  Bob           2024-01-02  src/app.js +5 −1
 *   c3  Alice         2024-01-03  rename src/app.js → src/main.js, +1 −1
 *   c4  Alice Smith   2024-01-04  src/main.js +2 −2, docs/guide.md +5
 *                                  (old identity, merged via .mailmap)
 *   m   —             2024-01-05  merge commit, excluded from H̄ (--no-merges)
 *   c5  Bob           2024-01-06  src/main.js +0 −3, README.md deleted (−2)
 *
 * Hand-computed over H̄ = {c1, cf, c2, c3, c4, c5} (|H̄| = 6):
 *   src/app.js  15/1  (c1, c2)   src/main.js 3/6 (c3, c4, c5 — rename target)
 *   README.md   2/2   (c1, c5)   docs/guide.md 5/0, docs/feature.md 3/0
 *   .mailmap    1/0
 *   totals: l+ 29, l- 9, churn 38; Alice 24/3 (4 commits), Bob 5/6 (2).
 */
const ROOT = path.join(process.cwd(), 'test', '.tmp-e2e');
const FIXTURE = path.join(ROOT, 'fixture-src');
const REPOS_DIR = path.join(ROOT, 'repos');
const DATA_DIR = path.join(process.cwd(), 'test', '.tmp-data');

const TS = {
  c1: 1704067200, // 2024-01-01T00:00:00Z
  c2: 1704153600,
  cf: 1704201600,
  c3: 1704240000,
  c4: 1704326400,
  c5: 1704499200,
} as const;

const APP_JS_V1 = `const a = 1;
const b = 2;
const c = 3;
const d = 4;
const e = 5;
const f = 6;
const g = 7;
const h = 8;
const i = 9;
const j = 10;
`;

// c2: "e" line changed (+1/−1) and four lines appended → +5 −1, 14 lines.
const APP_JS_V2 = `const a = 1;
const b = 2;
const c = 3;
const d = 4;
const e = 50;
const f = 6;
const g = 7;
const h = 8;
const i = 9;
const j = 10;
const k = 11;
const l = 12;
const m = 13;
const n = 14;
`;

// c3 renames src/app.js → src/main.js and changes one line (13/14 identical
// → well above the 50% rename-detection threshold).
const MAIN_JS_V1 = APP_JS_V2.replace('const a = 1;', 'const a = 100;');
// c4 changes two lines → +2 −2.
const MAIN_JS_V2 = MAIN_JS_V1.replace('const b = 2;', 'const b = 20;').replace(
  'const c = 3;',
  'const c = 30;',
);
// c5 drops the last three lines → +0 −3.
const MAIN_JS_V3 = MAIN_JS_V2.replace('\nconst l = 12;\nconst m = 13;\nconst n = 14;\n', '\n');

function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  try {
    execFileSync('git', args, {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : '';
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${detail || err}`);
  }
}

function buildFixture(): void {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(path.join(FIXTURE, 'src'), { recursive: true });
  mkdirSync(path.join(FIXTURE, 'docs'), { recursive: true });
  git(FIXTURE, ['init', '--quiet', '-b', 'main']);
  git(FIXTURE, ['config', 'user.name', 'RAT Fixture']);
  git(FIXTURE, ['config', 'user.email', 'fixture@rat.local']);
  git(FIXTURE, ['config', 'commit.gpgsign', 'false']);

  const commit = (when: string, author: string, message: string) =>
    git(FIXTURE, ['commit', '--quiet', `--author=${author}`, `--message=${message}`], {
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    });

  // c1 — initial commit (its parent is the empty commit, per the brief).
  writeFileSync(path.join(FIXTURE, 'src/app.js'), APP_JS_V1);
  writeFileSync(path.join(FIXTURE, 'README.md'), '# Fixture\n\n');
  writeFileSync(
    path.join(FIXTURE, '.mailmap'),
    'Alice <alice@example.com> <alice@old@example.com>\n',
  );
  writeFileSync(
    path.join(FIXTURE, 'logo.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]),
  );
  git(FIXTURE, ['add', '-A']);
  commit('2024-01-01T00:00:00Z', 'Alice <alice@example.com>', 'c1 initial');

  // cf — one commit on a side branch, merged back later.
  git(FIXTURE, ['checkout', '--quiet', '-b', 'feature']);
  writeFileSync(path.join(FIXTURE, 'docs/feature.md'), 'f1\nf2\nf3\n');
  git(FIXTURE, ['add', '-A']);
  commit('2024-01-02T12:00:00Z', 'Alice <alice@example.com>', 'cf feature');
  git(FIXTURE, ['checkout', '--quiet', 'main']);

  writeFileSync(path.join(FIXTURE, 'src/app.js'), APP_JS_V2);
  git(FIXTURE, ['add', '-A']);
  commit('2024-01-02T00:00:00Z', 'Bob <bob@example.com>', 'c2 tweak');

  git(FIXTURE, ['mv', 'src/app.js', 'src/main.js']);
  writeFileSync(path.join(FIXTURE, 'src/main.js'), MAIN_JS_V1);
  git(FIXTURE, ['add', '-A']);
  commit('2024-01-03T00:00:00Z', 'Alice <alice@example.com>', 'c3 rename');

  writeFileSync(path.join(FIXTURE, 'src/main.js'), MAIN_JS_V2);
  // `git checkout main` pruned the (now empty) docs/ directory when it removed
  // docs/feature.md, so it must be recreated before guide.md lands here.
  mkdirSync(path.join(FIXTURE, 'docs'), { recursive: true });
  writeFileSync(path.join(FIXTURE, 'docs/guide.md'), '# Guide\nstep 1\nstep 2\nstep 3\nstep 4\n');
  git(FIXTURE, ['add', '-A']);
  commit('2024-01-04T00:00:00Z', 'Alice Smith <alice@old@example.com>', 'c4 more');

  // m — the merge commit; it must never appear in any metric.
  git(
    FIXTURE,
    ['merge', '--quiet', '--no-ff', '--message=m merge feature', 'feature'],
    { GIT_AUTHOR_DATE: '2024-01-05T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-05T00:00:00Z' },
  );

  writeFileSync(path.join(FIXTURE, 'src/main.js'), MAIN_JS_V3);
  git(FIXTURE, ['rm', '--quiet', 'README.md']);
  git(FIXTURE, ['add', '-A']);
  commit('2024-01-06T00:00:00Z', 'Bob <bob@example.com>', 'c5 cleanup');
}

/** Recursively adds a directory (dotfiles included, so .git is captured). */
function addDirToZip(zip: AdmZip, dir: string, prefix: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) addDirToZip(zip, full, name);
    else if (entry.isFile()) zip.addFile(name, readFileSync(full));
  }
}

async function waitForJob(app: FastifyInstance, jobId: string): Promise<JobView> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const job = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` })).json() as JobView;
    if (job.stage === 'done' || job.stage === 'error') return job;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for job ${jobId}: ${JSON.stringify(job)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function uploadZip(app: FastifyInstance, zipPath: string, name: string) {
  const boundary = '----ratTestBoundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="repo.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    readFileSync(zipPath),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: '/api/repos/upload',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

function row(rows: MetricRow[], wanted: string): MetricRow {
  const found = rows.find((r) => r.path === wanted);
  if (!found) throw new Error(`no row for "${wanted}"; have: ${rows.map((r) => r.path).join(', ')}`);
  return found;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('RAT API end-to-end', () => {
  let app: FastifyInstance;
  let db: DB;
  let fixtureRepoId = 0;
  let zipRepoId = 0;

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
    buildFixture();
    mkdirSync(REPOS_DIR, { recursive: true });
    db = new Database(':memory:');
    initSchema(db);
    app = await buildApp(db, REPOS_DIR);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) db.close();
    rmSync(ROOT, { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('answers 404 for unknown repositories and 400 for missing fields', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/repos/999' })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/repos/url',
          headers: JSON_HEADERS,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });

  it('reports a failed clone as an errored job with no leftover data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/url',
      headers: JSON_HEADERS,
      payload: { url: path.join(ROOT, 'no-such-repo'), name: 'broken' },
    });
    expect(res.statusCode).toBe(202);
    const job = await waitForJob(app, (res.json() as { jobId: string }).jobId);
    expect(job.stage).toBe('error');
    expect(job.error).toMatch(/clone/i);

    const repos = (await app.inject({ method: 'GET', url: '/api/repos' })).json() as RepoSummary[];
    expect(repos).toEqual([]);
    expect(readdirSync(REPOS_DIR)).toEqual([]);
  });

  it('ingests a repository from a (local) URL clone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/url',
      headers: JSON_HEADERS,
      payload: { url: FIXTURE, name: 'fixture' },
    });
    expect(res.statusCode).toBe(202);
    const job = await waitForJob(app, (res.json() as { jobId: string }).jobId);
    expect(job.stage).toBe('done');
    expect(job.repoName).toBe('fixture');
    expect(job.commits).toBe(6); // 7 commits in history; the merge is excluded
    expect(job.files).toBe(10); // binary logo.png never reaches the parser
    fixtureRepoId = job.repoId!;

    const repos = (await app.inject({ method: 'GET', url: '/api/repos' })).json() as RepoSummary[];
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      name: 'fixture',
      status: 'ready',
      sourceType: 'url',
      commitCount: 6,
      fileCount: 6,
      dirCount: 3,
      firstTs: TS.c1,
      lastTs: TS.c5,
      headSubject: 'c5 cleanup',
    });
    expect(repos[0]!.headHash).toMatch(/^[0-9a-f]{40}$/);

    const detail = (await app.inject({ method: 'GET', url: `/api/repos/${fixtureRepoId}` }))
      .json() as RepoSummary;
    expect(detail.authorCount).toBe(2);
  });

  it('rejects a duplicate repository name through the job error path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/repos/url',
      headers: JSON_HEADERS,
      payload: { url: FIXTURE, name: 'fixture' },
    });
    const job = await waitForJob(app, (res.json() as { jobId: string }).jobId);
    expect(job.stage).toBe('error');
    expect(job.error).toMatch(/already exists/i);

    const repos = (await app.inject({ method: 'GET', url: '/api/repos' })).json() as RepoSummary[];
    expect(repos).toHaveLength(1); // the original fixture survived untouched
  });

  it('computes file metrics, attributing rename changes to the new path', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/files?limit=50`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commitSetSize: number; rows: MetricRow[] };
    expect(body.commitSetSize).toBe(6);

    expect(row(body.rows, 'src/app.js')).toMatchObject({
      added: 15,
      removed: 1,
      growth: 14,
      churn: 16,
      modifications: 2,
      frequency: 2 / 6,
      churnRate: 16 / 6,
    });
    // c3 renamed app.js → main.js; its +1 −1 lands on the new path only.
    expect(row(body.rows, 'src/main.js')).toMatchObject({
      added: 3,
      removed: 6,
      growth: -3,
      churn: 9,
      modifications: 3,
    });
    // c5 deleted README.md: recorded as removed lines on the deleted path.
    expect(row(body.rows, 'README.md')).toMatchObject({
      added: 2,
      removed: 2,
      churn: 4,
      modifications: 2,
    });
    expect(row(body.rows, 'docs/guide.md')).toMatchObject({ added: 5, churn: 5, modifications: 1 });
    expect(row(body.rows, 'docs/feature.md')).toMatchObject({ added: 3, churn: 3, modifications: 1 });
    expect(row(body.rows, '.mailmap')).toMatchObject({ added: 1, churn: 1, modifications: 1 });
    expect(body.rows.find((r) => r.path === 'logo.png')).toBeUndefined(); // binary
  });

  it('computes directory metrics as recursive rollups', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/dirs?limit=50`,
    });
    const body = res.json() as { commitSetSize: number; rows: MetricRow[] };
    expect(body.commitSetSize).toBe(6);
    expect(row(body.rows, '/')).toMatchObject({
      added: 29,
      removed: 9,
      growth: 20,
      churn: 38,
      modifications: 6,
    });
    expect(row(body.rows, 'src')).toMatchObject({ added: 18, removed: 7, churn: 25, modifications: 5 });
    expect(row(body.rows, 'docs')).toMatchObject({ added: 8, removed: 0, churn: 8, modifications: 2 });
  });

  it('computes repository metrics (directory metrics on the root)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/repository`,
    });
    expect(res.json()).toEqual({
      commitSetSize: 6,
      authorCount: 2,
      added: 29,
      removed: 9,
      growth: 20,
      churn: 38,
      modifications: 6,
      firstTs: TS.c1,
      lastTs: TS.c5,
    });
  });

  it('merges identities via .mailmap and computes author metrics', async () => {
    const list = (await app.inject({ method: 'GET', url: `/api/repos/${fixtureRepoId}/authors` }))
      .json() as { authors: AuthorView[] };
    expect(list.authors).toHaveLength(2);
    const alice = list.authors.find((a) => a.name === 'Alice')!;
    const bob = list.authors.find((a) => a.name === 'Bob')!;
    expect(alice.aliases).toContainEqual({
      name: 'Alice Smith',
      email: 'alice@old@example.com',
      source: 'mailmap',
    });
    expect(alice.commitCount).toBe(4);
    expect(bob.commitCount).toBe(2);

    const res = await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/authors`,
    });
    const body = res.json() as { commitSetSize: number; rows: AuthorMetric[] };
    expect(body.commitSetSize).toBe(6);
    expect(body.rows.find((r) => r.name === 'Alice')).toMatchObject({
      added: 24,
      removed: 3,
      churn: 27,
      modifications: 4,
      ownership: 27 / 38,
    });
    expect(body.rows.find((r) => r.name === 'Bob')).toMatchObject({
      added: 5,
      removed: 6,
      churn: 11,
      modifications: 2,
      ownership: 11 / 38,
    });
  });

  it('buckets the churn timeline by committer date', async () => {
    const month = (await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/timeline?bucket=month`,
    })).json() as { points: TimelinePoint[] };
    expect(month.points).toEqual([
      { bucket: '2024-01', commits: 6, added: 29, removed: 9, growth: 20 },
    ]);

    const day = (await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/timeline?bucket=day&since=${TS.c2}&until=${TS.c4}`,
    })).json() as { points: TimelinePoint[] };
    expect(day.points).toEqual([
      { bucket: '2024-01-02', commits: 2, added: 8, removed: 1, growth: 7 }, // c2 + cf
      { bucket: '2024-01-03', commits: 1, added: 1, removed: 1, growth: 0 }, // c3
    ]);
  });

  it('supports committer-date windows (H_i inclusive, H_j exclusive)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/files?since=${TS.c2}&until=${TS.c4}&limit=50`,
    });
    const body = res.json() as { commitSetSize: number; rows: MetricRow[] };
    expect(body.commitSetSize).toBe(3); // c2, cf, c3 — never the merge
    expect(row(body.rows, 'src/app.js')).toMatchObject({ added: 5, removed: 1, churn: 6, modifications: 1 });
    expect(row(body.rows, 'src/main.js')).toMatchObject({ added: 1, removed: 1, modifications: 1 });
    expect(row(body.rows, 'docs/feature.md')).toMatchObject({ added: 3, modifications: 1 });
  });

  it('supports an explicit commit subset', async () => {
    const list = (await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/commits?limit=100`,
    })).json() as { total: number; commits: CommitListItem[] };
    expect(list.total).toBe(6);
    const hashOf = (prefix: string) =>
      list.commits.find((c) => c.subject.startsWith(prefix))!.hash;

    const res = await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/files?commits=${hashOf('c1 initial')},${hashOf('c3 rename')}&limit=50`,
    });
    const body = res.json() as { commitSetSize: number; rows: MetricRow[] };
    expect(body.commitSetSize).toBe(2);
    expect(row(body.rows, 'src/app.js')).toMatchObject({ added: 10, removed: 0, modifications: 1 });
    expect(row(body.rows, 'src/main.js')).toMatchObject({ added: 1, removed: 1, modifications: 1 });
    expect(row(body.rows, 'README.md')).toMatchObject({ added: 2, removed: 0, modifications: 1 });
  });

  it('scopes path filters to the measured objects without narrowing H̄', async () => {
    const files = (await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/files?path=docs&limit=50`,
    })).json() as { commitSetSize: number; rows: MetricRow[] };
    expect(files.commitSetSize).toBe(6);
    expect(files.rows.map((r) => r.path).sort()).toEqual(['docs/feature.md', 'docs/guide.md']);

    const repo = (await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/repository?path=src`,
    })).json();
    expect(repo).toMatchObject({
      commitSetSize: 6,
      added: 18,
      removed: 7,
      churn: 25,
      modifications: 5,
    });
  });

  it('filters the commit set by canonical author', async () => {
    const list = (await app.inject({ method: 'GET', url: `/api/repos/${fixtureRepoId}/authors` }))
      .json() as { authors: AuthorView[] };
    const aliceId = list.authors.find((a) => a.name === 'Alice')!.id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/files?authorId=${aliceId}&limit=50`,
    });
    const body = res.json() as { commitSetSize: number; rows: MetricRow[] };
    expect(body.commitSetSize).toBe(4);
    expect(row(body.rows, 'src/app.js')).toMatchObject({ added: 10, removed: 0, modifications: 1 });
    // Bob's c5 deletion of README.md is outside this commit set.
    expect(row(body.rows, 'README.md')).toMatchObject({ added: 2, removed: 0, modifications: 1 });
  });

  it('pages the commit list newest-first', async () => {
    const page1 = (await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/commits?limit=2&offset=0`,
    })).json() as { total: number; commits: CommitListItem[] };
    expect(page1.total).toBe(6);
    expect(page1.commits.map((c) => c.subject)).toEqual(['c5 cleanup', 'c4 more']);
    expect(page1.commits[0]).toMatchObject({
      authorName: 'Bob',
      authorEmail: 'bob@example.com',
      committerTs: TS.c5,
    });

    const page2 = (await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/commits?limit=2&offset=2`,
    })).json() as { commits: CommitListItem[] };
    expect(page2.commits.map((c) => c.subject)).toEqual(['c3 rename', 'cf feature']);
  });

  it('rejects invalid query parameters', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/repos/${fixtureRepoId}/metrics/files?since=abc`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/repos/${fixtureRepoId}/metrics/files?commits=,`,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('ingests a zip upload through the multipart endpoint', async () => {
    const zipPath = path.join(ROOT, 'fixture.zip');
    const zip = new AdmZip();
    addDirToZip(zip, FIXTURE, 'fixture-repo'); // one nesting level, like real repo zips
    zip.writeZip(zipPath);

    const res = await uploadZip(app, zipPath, 'zip-fixture');
    expect(res.statusCode).toBe(202);
    const job = await waitForJob(app, (res.json() as { jobId: string }).jobId);
    expect(job.stage).toBe('done');
    expect(job.commits).toBe(6);

    const repos = (await app.inject({ method: 'GET', url: '/api/repos' })).json() as RepoSummary[];
    const zipped = repos.find((r) => r.name === 'zip-fixture')!;
    expect(zipped.status).toBe('ready');
    expect(zipped.sourceType).toBe('zip');
    expect(zipped.commitCount).toBe(6);
    zipRepoId = zipped.id;

    const metrics = (await app.inject({
      method: 'GET',
      url: `/api/repos/${zipRepoId}/metrics/repository`,
    })).json();
    expect(metrics).toMatchObject({ commitSetSize: 6, added: 29, removed: 9, churn: 38 });
  });

  it('deletes a repository with its stored worktree', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/repos/${zipRepoId}` });
    expect(res.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/repos/${zipRepoId}` })).statusCode).toBe(
      404,
    );
    expect(readdirSync(REPOS_DIR).includes(`${zipRepoId}-zip-fixture`)).toBe(false);
    const repos = (await app.inject({ method: 'GET', url: '/api/repos' })).json() as RepoSummary[];
    expect(repos.map((r) => r.name)).toEqual(['fixture']);
  });

  it('merges and unmerges authors through the API', async () => {
    const getAuthors = async () =>
      (await app.inject({ method: 'GET', url: `/api/repos/${fixtureRepoId}/authors` })).json() as {
        authors: AuthorView[];
      };

    const before = await getAuthors();
    const alice = before.authors.find((a) => a.name === 'Alice')!;
    const bob = before.authors.find((a) => a.name === 'Bob')!;

    const selfMerge = await app.inject({
      method: 'POST',
      url: `/api/repos/${fixtureRepoId}/authors/merge`,
      headers: JSON_HEADERS,
      payload: { targetId: alice.id, sourceIds: [alice.id] },
    });
    expect(selfMerge.statusCode).toBe(400);

    const merged = await app.inject({
      method: 'POST',
      url: `/api/repos/${fixtureRepoId}/authors/merge`,
      headers: JSON_HEADERS,
      payload: { targetId: alice.id, sourceIds: [bob.id] },
    });
    expect(merged.statusCode).toBe(200);
    expect((merged.json() as { authors: AuthorView[] }).authors).toHaveLength(1);

    const metrics = (await app.inject({
      method: 'GET',
      url: `/api/repos/${fixtureRepoId}/metrics/authors`,
    })).json() as { rows: AuthorMetric[] };
    expect(metrics.rows).toHaveLength(1);
    expect(metrics.rows[0]).toMatchObject({ name: 'Alice', churn: 38, modifications: 6, ownership: 1 });

    const split = await app.inject({
      method: 'POST',
      url: `/api/repos/${fixtureRepoId}/authors/unmerge`,
      headers: JSON_HEADERS,
      payload: { name: 'Bob', email: 'bob@example.com' },
    });
    expect(split.statusCode).toBe(200);
    expect((split.json() as { authors: AuthorView[] }).authors).toHaveLength(2);

    const refused = await app.inject({
      method: 'POST',
      url: `/api/repos/${fixtureRepoId}/authors/unmerge`,
      headers: JSON_HEADERS,
      payload: { name: 'Bob', email: 'bob@example.com' },
    });
    expect(refused.statusCode).toBe(400);
  });
});
