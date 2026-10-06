import Database from 'better-sqlite3';
import fs from 'node:fs';
import { config, dbFile } from '../config';

export type DB = Database.Database;

/**
 * Star schema around commits:
 *
 *   repositories ─┬─ commits ─┬─ file_changes   (one row per commit × touched file)
 *                 │            └─ dir_changes    (per-commit rollup per ancestor dir)
 *                 ├─ canonical_authors
 *                 └─ author_aliases  (identity (name,email) → canonical author)
 *
 * Growth (added - removed) and churn (added + removed) are never stored —
 * they are cheap to derive and storing them would be redundant.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'ingesting' CHECK (status IN ('ingesting', 'ready', 'error')),
  source_type   TEXT NOT NULL CHECK (source_type IN ('url', 'zip')),
  source_ref    TEXT,
  head_hash     TEXT NOT NULL DEFAULT '',
  head_subject  TEXT,
  ingested_at   TEXT NOT NULL,
  commit_count  INTEGER NOT NULL DEFAULT 0,
  file_count    INTEGER NOT NULL DEFAULT 0,
  dir_count     INTEGER NOT NULL DEFAULT 0,
  first_ts      INTEGER,
  last_ts       INTEGER
);

CREATE TABLE IF NOT EXISTS commits (
  repo_id       INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  hash          TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  author_email  TEXT NOT NULL,
  committer_ts  INTEGER NOT NULL,
  subject       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (repo_id, hash)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_commits_ts     ON commits (repo_id, committer_ts);
CREATE INDEX IF NOT EXISTS idx_commits_author ON commits (repo_id, author_name, author_email);

CREATE TABLE IF NOT EXISTS file_changes (
  repo_id       INTEGER NOT NULL,
  commit_hash   TEXT NOT NULL,
  path          TEXT NOT NULL,
  added         INTEGER NOT NULL,
  removed       INTEGER NOT NULL,
  PRIMARY KEY (repo_id, commit_hash, path),
  FOREIGN KEY (repo_id, commit_hash) REFERENCES commits (repo_id, hash) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes (repo_id, path);

CREATE TABLE IF NOT EXISTS dir_changes (
  repo_id       INTEGER NOT NULL,
  commit_hash   TEXT NOT NULL,
  path          TEXT NOT NULL,
  added         INTEGER NOT NULL,
  removed       INTEGER NOT NULL,
  PRIMARY KEY (repo_id, commit_hash, path),
  FOREIGN KEY (repo_id, commit_hash) REFERENCES commits (repo_id, hash) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_dir_changes_path ON dir_changes (repo_id, path);

CREATE TABLE IF NOT EXISTS canonical_authors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  UNIQUE (repo_id, name, email)
);

CREATE TABLE IF NOT EXISTS author_aliases (
  repo_id       INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  alias_name    TEXT NOT NULL,
  alias_email   TEXT NOT NULL,
  canonical_id  INTEGER NOT NULL REFERENCES canonical_authors(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('identity', 'mailmap', 'manual')),
  PRIMARY KEY (repo_id, alias_name, alias_email)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_author_aliases_canonical ON author_aliases (repo_id, canonical_id);
`;

export function initSchema(db: DB): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');
  db.exec(SCHEMA);
}

export function openDatabase(): DB {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(dbFile());
  initSchema(db);
  return db;
}
