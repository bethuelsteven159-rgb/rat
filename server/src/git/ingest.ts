import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/database';
import { buildAuthorModel } from '../authors/model';
import { parseMailmap } from '../authors/mailmap';
import { cloneRepo, extractZip, findWorktree } from './acquire';
import { runGit, spawnGitLog } from './git';
import { parseGitLog } from './logParser';
import { rollupDirs } from './rollup';

export interface IngestInput {
  sourceType: 'url' | 'zip';
  /** Remote URL (or local path) to clone, or path to an uploaded zip file. */
  source: string;
  name?: string;
}

export interface IngestDeps {
  db: DB;
  /** Directory clones/extracted zips are stored in. */
  reposDir: string;
}

export type JobStage = 'queued' | 'acquiring' | 'parsing' | 'authors' | 'done' | 'error';

export interface Job {
  id: string;
  repoName: string;
  stage: JobStage;
  commits: number;
  files: number;
  error?: string;
  repoId?: number;
}

/** In-memory ingestion jobs; progress is polled via GET /api/jobs/:id. */
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private counter = 0;

  create(repoName: string): Job {
    const job: Job = {
      id: `j${++this.counter}-${Date.now().toString(36)}`,
      repoName,
      stage: 'queued',
      commits: 0,
      files: 0,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return Array.from(this.jobs.values()).slice(-50);
  }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'repo'
  );
}

function resolveRepoName(db: DB, input: IngestInput): string {
  let name = input.name?.trim() ?? '';
  if (!name) {
    name =
      input.sourceType === 'url'
        ? input.source.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
        : path.basename(input.source);
    name = name.replace(/\.git$/i, '').replace(/\.zip$/i, '');
  }
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name)) {
    throw new Error(`Invalid repository name: "${name}"`);
  }
  if (db.prepare('SELECT id FROM repositories WHERE name = ?').get(name)) {
    throw new Error(`A repository named "${name}" already exists`);
  }
  return name;
}

async function readMailmap(worktree: string): Promise<string> {
  try {
    return await runGit(worktree, ['show', 'HEAD:.mailmap']);
  } catch {
    try {
      return readFileSync(path.join(worktree, '.mailmap'), 'utf8');
    } catch {
      return '';
    }
  }
}

interface IngestCounts {
  commits: number;
  fileCount: number;
  dirCount: number;
  firstTs: number | null;
  lastTs: number | null;
}

/** Streams git log output into commits/file_changes/dir_changes in batches. */
async function ingestCommits(
  db: DB,
  repoId: number,
  worktree: string,
  job: Job,
): Promise<IngestCounts> {
  const insertCommit = db.prepare(
    'INSERT INTO commits (repo_id, hash, author_name, author_email, committer_ts, subject) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertFile = db.prepare(
    'INSERT INTO file_changes (repo_id, commit_hash, path, added, removed) VALUES (?, ?, ?, ?, ?)',
  );
  const insertDir = db.prepare(
    'INSERT INTO dir_changes (repo_id, commit_hash, path, added, removed) VALUES (?, ?, ?, ?, ?)',
  );

  const batch = {
    commits: [] as Array<[string, string, string, number, string]>,
    files: [] as Array<[string, string, number, number]>,
    dirs: [] as Array<[string, string, number, number]>,
  };

  const filePaths = new Set<string>();
  const dirPaths = new Set<string>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let commitCounter = 0;
  let fileCounter = 0;

  const flush = db.transaction((b: typeof batch) => {
    for (const [hash, name, email, ts, subject] of b.commits) {
      insertCommit.run(repoId, hash, name, email, ts, subject);
    }
    for (const [hash, filePath, added, removed] of b.files) {
      insertFile.run(repoId, hash, filePath, added, removed);
    }
    for (const [hash, dirPath, added, removed] of b.dirs) {
      insertDir.run(repoId, hash, dirPath, added, removed);
    }
  });

  const proc = spawnGitLog(worktree);
  let stderrTail = '';
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  const exitCode = new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git log failed (exit ${code}): ${stderrTail.trim()}`));
    });
    proc.on('error', reject);
  });

  await parseGitLog(proc.stdout!, (commit) => {
    commitCounter++;
    fileCounter += commit.files.length;
    firstTs = firstTs === null ? commit.committerTs : Math.min(firstTs, commit.committerTs);
    lastTs = lastTs === null ? commit.committerTs : Math.max(lastTs, commit.committerTs);

    batch.commits.push([
      commit.hash,
      commit.authorName,
      commit.authorEmail,
      commit.committerTs,
      commit.subject,
    ]);
    for (const file of commit.files) {
      batch.files.push([commit.hash, file.path, file.added, file.removed]);
      filePaths.add(file.path);
    }
    for (const dir of rollupDirs(commit.files)) {
      batch.dirs.push([commit.hash, dir.path, dir.added, dir.removed]);
      dirPaths.add(dir.path);
    }

    job.commits = commitCounter;
    job.files = fileCounter;

    if (batch.commits.length >= 1000) {
      flush(batch);
      batch.commits = [];
      batch.files = [];
      batch.dirs = [];
    }
  });

  await exitCode;
  if (batch.commits.length > 0) flush(batch);

  return {
    commits: commitCounter,
    fileCount: filePaths.size,
    dirCount: dirPaths.size,
    firstTs,
    lastTs,
  };
}

/**
 * Full ingestion pipeline: acquire → parse → store → author model → stats.
 *
 * On any failure the repository row (and, via foreign keys, all its commits
 * and change rows) is deleted and the extracted files are removed, so a
 * failed upload never leaves partial data behind.
 */
export async function ingestRepository(
  deps: IngestDeps,
  input: IngestInput,
  job: Job,
): Promise<number> {
  const db = deps.db;
  let repoId: number | undefined;
  let worktreeRoot = '';

  try {
    const name = resolveRepoName(db, input);
    job.repoName = name;

    const info = db
      .prepare(
        "INSERT INTO repositories (name, status, source_type, source_ref, ingested_at) VALUES (?, 'ingesting', ?, ?, ?)",
      )
      .run(name, input.sourceType, input.source, new Date().toISOString());
    repoId = Number(info.lastInsertRowid);
    job.repoId = repoId;

    worktreeRoot = path.join(deps.reposDir, `${repoId}-${slugify(name)}`);

    job.stage = 'acquiring';
    if (input.sourceType === 'url') {
      await cloneRepo(input.source, worktreeRoot);
    } else {
      extractZip(input.source, worktreeRoot);
      rmSync(input.source, { force: true }); // uploaded zips are single-use
    }
    const worktree = findWorktree(worktreeRoot);

    const head = (await runGit(worktree, ['rev-parse', 'HEAD'])).trim();
    if (!head) throw new Error('Repository has no commits');
    const subject = (await runGit(worktree, ['log', '-1', '--format=%s'])).trim();

    job.stage = 'parsing';
    const counts = await ingestCommits(db, repoId, worktree, job);

    job.stage = 'authors';
    const mailmap = await readMailmap(worktree);
    buildAuthorModel(db, repoId, parseMailmap(mailmap));

    db.prepare(
      `UPDATE repositories
         SET status = 'ready', head_hash = ?, head_subject = ?,
             commit_count = ?, file_count = ?, dir_count = ?, first_ts = ?, last_ts = ?
       WHERE id = ?`,
    ).run(
      head,
      subject,
      counts.commits,
      counts.fileCount,
      counts.dirCount,
      counts.firstTs,
      counts.lastTs,
      repoId,
    );

    job.stage = 'done';
    return repoId;
  } catch (err) {
    if (repoId !== undefined) {
      db.prepare('DELETE FROM repositories WHERE id = ?').run(repoId);
    }
    if (worktreeRoot !== '') {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    job.stage = 'error';
    job.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
}
