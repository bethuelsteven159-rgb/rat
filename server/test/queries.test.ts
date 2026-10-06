import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSchema, type DB } from '../src/db/database';
import { rollupDirs } from '../src/git/rollup';
import {
  authorMetrics,
  commitSetSize,
  listAuthors,
  listCommits,
  mergeAuthors,
  objectMetrics,
  repositoryMetrics,
  timeline,
  unmergeAlias,
} from '../src/metrics/queries';

/**
 * Fixture (ts values land on distinct days/months in 1970):
 *
 *   commits: c1 Alice        ts 86400*10
 *            c2 Bob          ts 86400*40
 *            c3 Alice Smith  ts 86400*70
 *            c4 Alice        ts 86400*100
 *            c5 Bob          ts 86400*130
 *
 *   file_changes:
 *            c1: src/a/f1 +10 -2
 *            c2: src/a/f1 +3 -3, src/b/f2 +5 -0
 *            c3: src/a/f1 +0 -4
 *            c4: src/b/f2 +2 -2
 *            c5: src/b/f2 +1 -1
 *
 *   canonical: 1 = Alice (aliases: Alice <alice@x>, Alice Smith <alice.smith@x>)
 *              2 = Bob   (alias:  Bob <bob@x>)
 */
const DAY = 86_400;

let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  initSchema(db);
  db
    .prepare(
      "INSERT INTO repositories (name, status, source_type, source_ref, ingested_at) VALUES ('fixture', 'ready', 'url', 'x', '2024-01-01')",
    )
    .run();

  const insertCommit = db.prepare(
    'INSERT INTO commits (repo_id, hash, author_name, author_email, committer_ts, subject) VALUES (1, ?, ?, ?, ?, ?)',
  );
  insertCommit.run('c1', 'Alice', 'alice@x', DAY * 10, 'c1');
  insertCommit.run('c2', 'Bob', 'bob@x', DAY * 40, 'c2');
  insertCommit.run('c3', 'Alice Smith', 'alice.smith@x', DAY * 70, 'c3');
  insertCommit.run('c4', 'Alice', 'alice@x', DAY * 100, 'c4');
  insertCommit.run('c5', 'Bob', 'bob@x', DAY * 130, 'c5');

  const insertFile = db.prepare(
    'INSERT INTO file_changes (repo_id, commit_hash, path, added, removed) VALUES (1, ?, ?, ?, ?)',
  );
  insertFile.run('c1', 'src/a/f1', 10, 2);
  insertFile.run('c2', 'src/a/f1', 3, 3);
  insertFile.run('c2', 'src/b/f2', 5, 0);
  insertFile.run('c3', 'src/a/f1', 0, 4);
  insertFile.run('c4', 'src/b/f2', 2, 2);
  insertFile.run('c5', 'src/b/f2', 1, 1);

  const insertDir = db.prepare(
    'INSERT INTO dir_changes (repo_id, commit_hash, path, added, removed) VALUES (1, ?, ?, ?, ?)',
  );
  const perCommitFiles: Record<string, Array<{ path: string; added: number; removed: number }>> = {
    c1: [{ path: 'src/a/f1', added: 10, removed: 2 }],
    c2: [
      { path: 'src/a/f1', added: 3, removed: 3 },
      { path: 'src/b/f2', added: 5, removed: 0 },
    ],
    c3: [{ path: 'src/a/f1', added: 0, removed: 4 }],
    c4: [{ path: 'src/b/f2', added: 2, removed: 2 }],
    c5: [{ path: 'src/b/f2', added: 1, removed: 1 }],
  };
  for (const [hash, files] of Object.entries(perCommitFiles)) {
    for (const dir of rollupDirs(files)) {
      insertDir.run(hash, dir.path, dir.added, dir.removed);
    }
  }

  const insertCanonical = db.prepare(
    'INSERT INTO canonical_authors (repo_id, name, email) VALUES (1, ?, ?)',
  );
  insertCanonical.run('Alice', 'alice@x'); // id 1
  insertCanonical.run('Bob', 'bob@x'); // id 2
  const insertAlias = db.prepare(
    'INSERT INTO author_aliases (repo_id, alias_name, alias_email, canonical_id, source) VALUES (1, ?, ?, ?, ?)',
  );
  insertAlias.run('Alice', 'alice@x', 1, 'identity');
  insertAlias.run('Alice Smith', 'alice.smith@x', 1, 'mailmap');
  insertAlias.run('Bob', 'bob@x', 2, 'identity');
});

afterEach(() => {
  db.close();
});

const row = (rows: Array<{ path: string }>, path: string) =>
  rows.find((r) => r.path === path)!;

describe('rollupDirs', () => {
  it('accumulates every ancestor directory and the root', () => {
    expect(rollupDirs([{ path: 'src/a/f1', added: 10, removed: 2 }])).toEqual([
      { path: '/', added: 10, removed: 2 },
      { path: 'src', added: 10, removed: 2 },
      { path: 'src/a', added: 10, removed: 2 },
    ]);
  });

  it('merges siblings into the same directory entry', () => {
    expect(
      rollupDirs([
        { path: 'src/a/f1', added: 1, removed: 0 },
        { path: 'src/b/f2', added: 2, removed: 5 },
      ]),
    ).toEqual([
      { path: '/', added: 3, removed: 5 },
      { path: 'src', added: 3, removed: 5 },
      { path: 'src/a', added: 1, removed: 0 },
      { path: 'src/b', added: 2, removed: 5 },
    ]);
  });

  it('handles root-level files', () => {
    expect(rollupDirs([{ path: 'README.md', added: 3, removed: 0 }])).toEqual([
      { path: '/', added: 3, removed: 0 },
    ]);
  });
});

describe('file and directory metrics', () => {
  it('computes every metric over the full commit set', () => {
    const { commitSetSize, rows } = objectMetrics(db, 1, {}, { kind: 'file', limit: 10 });
    expect(commitSetSize).toBe(5);

    const f1 = row(rows, 'src/a/f1');
    expect(f1).toMatchObject({
      added: 13,
      removed: 9,
      growth: 4,
      churn: 22,
      modifications: 3,
      frequency: 0.6,
      churnRate: 4.4,
    });
    const f2 = row(rows, 'src/b/f2');
    expect(f2).toMatchObject({
      added: 8,
      removed: 3,
      growth: 5,
      churn: 11,
      modifications: 3,
      frequency: 0.6,
      churnRate: 2.2,
    });

    const dirs = objectMetrics(db, 1, {}, { kind: 'dir', limit: 10 }).rows;
    expect(row(dirs, '/')).toMatchObject({ added: 21, removed: 12, churn: 33, modifications: 5 });
    expect(row(dirs, 'src')).toMatchObject({ added: 21, removed: 12, churn: 33, modifications: 5 });
    expect(row(dirs, 'src/a')).toMatchObject({ added: 13, removed: 9, churn: 22, modifications: 3 });
    expect(row(dirs, 'src/b')).toMatchObject({ added: 8, removed: 3, churn: 11, modifications: 3 });
  });

  it('H_i,j window: since inclusive, until exclusive', () => {
    const filter = { since: DAY * 40, until: DAY * 100 }; // c2, c3
    expect(commitSetSize(db, 1, filter)).toBe(2);

    const { rows } = objectMetrics(db, 1, filter, { kind: 'file', limit: 10 });
    expect(row(rows, 'src/a/f1')).toMatchObject({
      added: 3,
      removed: 7,
      churn: 10,
      modifications: 2,
      frequency: 1,
      churnRate: 5,
    });
    expect(row(rows, 'src/b/f2')).toMatchObject({ added: 5, removed: 0, churn: 5, frequency: 0.5 });
  });

  it('explicit commit subset', () => {
    const filter = { commits: ['c1', 'c4'] };
    const { commitSetSize, rows } = objectMetrics(db, 1, filter, { kind: 'file', limit: 10 });
    expect(commitSetSize).toBe(2);
    expect(row(rows, 'src/a/f1')).toMatchObject({ added: 10, removed: 2, churn: 12, modifications: 1, frequency: 0.5 });
    expect(row(rows, 'src/b/f2')).toMatchObject({ added: 2, removed: 2, churn: 4, modifications: 1, frequency: 0.5 });
  });

  it('canonical author filter (post-merge identities both match)', () => {
    const filter = { authorId: 1 }; // Alice + Alice Smith
    expect(commitSetSize(db, 1, filter)).toBe(3);
    const { rows } = objectMetrics(db, 1, filter, { kind: 'file', limit: 10 });
    expect(row(rows, 'src/a/f1')).toMatchObject({ added: 10, removed: 6, churn: 16, modifications: 2, frequency: 2 / 3 });
    expect(row(rows, 'src/b/f2')).toMatchObject({ added: 2, removed: 2, churn: 4, modifications: 1, frequency: 1 / 3 });
  });

  it('pathPrefix scopes objects without narrowing the commit set', () => {
    const { commitSetSize, rows } = objectMetrics(db, 1, {}, { kind: 'file', pathPrefix: 'src/a', limit: 10 });
    expect(commitSetSize).toBe(5);
    expect(rows.map((r) => r.path)).toEqual(['src/a/f1']);
  });

  it('returns zero frequency and churn rate for an empty commit set', () => {
    const filter = { since: 9_999_999_999 };
    expect(commitSetSize(db, 1, filter)).toBe(0);
    const repo = repositoryMetrics(db, 1, filter);
    expect(repo.commitSetSize).toBe(0);
    expect(repo.churn).toBe(0);
    const { rows } = objectMetrics(db, 1, filter, { kind: 'file', limit: 10 });
    expect(rows).toHaveLength(0);
  });
});

describe('repository metrics', () => {
  it('root rollup over the full set', () => {
    expect(repositoryMetrics(db, 1, {})).toMatchObject({
      commitSetSize: 5,
      authorCount: 2,
      added: 21,
      removed: 12,
      growth: 9,
      churn: 33,
      modifications: 5,
      firstTs: DAY * 10,
      lastTs: DAY * 130,
    });
  });

  it('pathPrefix switches the measured object to a subtree', () => {
    expect(repositoryMetrics(db, 1, {}, 'src/b')).toMatchObject({
      commitSetSize: 5,
      added: 8,
      removed: 3,
      churn: 11,
      modifications: 3,
    });
  });
});

describe('author metrics', () => {
  it('churn, modifications and ownership over the full set', () => {
    const { rows } = authorMetrics(db, 1, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'Alice',
      email: 'alice@x',
      added: 12,
      removed: 8,
      churn: 20,
      modifications: 3,
      ownership: 20 / 33,
    });
    expect(rows[1]).toMatchObject({
      name: 'Bob',
      email: 'bob@x',
      added: 9,
      removed: 4,
      churn: 13,
      modifications: 2,
      ownership: 13 / 33,
    });
    expect(rows[0]!.ownership + rows[1]!.ownership).toBeCloseTo(1, 10);
  });

  it('path subtree scoping', () => {
    const { rows } = authorMetrics(db, 1, {}, 'src/a');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'Alice', churn: 16, modifications: 2 });
    expect(rows[1]).toMatchObject({ name: 'Bob', churn: 6, modifications: 1 });
  });
});

describe('timeline', () => {
  it('buckets by month with per-bucket commit counts', () => {
    const points = timeline(db, 1, {}, 'month');
    expect(points.map((p) => p.bucket)).toEqual([
      '1970-01',
      '1970-02',
      '1970-03',
      '1970-04',
      '1970-05',
    ]);
    expect(points[0]).toMatchObject({ commits: 1, added: 10, removed: 2, growth: 8 });
    expect(points[1]).toMatchObject({ commits: 1, added: 8, removed: 3 });
    expect(points[2]).toMatchObject({ commits: 1, added: 0, removed: 4, growth: -4 });
    expect(points[3]).toMatchObject({ commits: 1, added: 2, removed: 2, growth: 0 });
    expect(points[4]).toMatchObject({ commits: 1, added: 1, removed: 1 });
  });

  it('respects time filters', () => {
    const points = timeline(db, 1, { since: DAY * 40, until: DAY * 100 }, 'day');
    expect(points).toHaveLength(2); // c2 (day 41), c3 (day 71)
    expect(points.reduce((s, p) => s + p.commits, 0)).toBe(2);
  });
});

describe('commit listing', () => {
  it('pages newest-first and reports the total', () => {
    const { total, commits } = listCommits(db, 1, {}, 3, 0);
    expect(total).toBe(5);
    expect(commits.map((c) => c.hash)).toEqual(['c5', 'c4', 'c3']);
    expect(commits[0]).toMatchObject({ subject: 'c5', authorName: 'Bob', authorEmail: 'bob@x' });
  });
});

describe('author management', () => {
  it('lists canonical authors with aliases and stats', () => {
    const authors = listAuthors(db, 1);
    expect(authors).toHaveLength(2);
    const alice = authors.find((a) => a.name === 'Alice')!;
    expect(alice.aliases).toEqual([
      { name: 'Alice', email: 'alice@x', source: 'identity' },
      { name: 'Alice Smith', email: 'alice.smith@x', source: 'mailmap' },
    ]);
    expect(alice.commitCount).toBe(3);
  });

  it('manual merge folds one canonical author into another', () => {
    mergeAuthors(db, 1, 1, [2]);
    const authors = listAuthors(db, 1);
    expect(authors).toHaveLength(1);
    expect(authors[0]!.aliases).toHaveLength(3);
    // Metric queries reflect the merge immediately.
    const { rows } = authorMetrics(db, 1, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.churn).toBe(33);
    expect(rows[0]!.ownership).toBe(1);
  });

  it('unmerge splits an identity back out', () => {
    expect(unmergeAlias(db, 1, 'Alice Smith', 'alice.smith@x')).toEqual({ ok: true });
    const authors = listAuthors(db, 1);
    expect(authors).toHaveLength(3);
    const smith = authors.find((a) => a.email === 'alice.smith@x')!;
    expect(smith.name).toBe('Alice Smith');
    expect(smith.commitCount).toBe(1);
    // Refuses to split an identity that already stands alone.
    expect(unmergeAlias(db, 1, 'Alice Smith', 'alice.smith@x')).toEqual({
      ok: false,
      reason: 'Identity is already its own canonical author',
    });
  });
});
