# Architecture

## Overview

```
                    ┌──────────────────────┐
  git URL ────────► │  acquisition         │  clone / unzip → worktree
  zip upload ─────► │  (src/git/acquire)   │  under RAT_DATA_DIR/repos
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │  git log -z pipeline │  spawn + stream parse
                    │  (src/git/…)         │  (rename-aware, binary-skipping)
                    └──────────┬───────────┘
                               ▼
        ┌──────────────── SQLite (star schema) ────────────────┐
        │  repositories ─► commits ─► file_changes / dir_changes │
        │                 └► canonical_authors / author_aliases  │
        └──────────────────────┬─────────────────────────────┘
                               ▼
                    ┌──────────────────────┐
   REST /api/…  ◄── │  metric queries      │  SQL aggregation only —
                    │  (src/metrics)       │  no recomputation on merges
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │  React + ECharts     │  tables, cards, timeline
                    │  (web/)              │
                    └──────────────────────┘
```

## Ingestion pipeline

`POST /api/repos/url` or `POST /api/repos/upload` returns `202 { jobId}` and
runs ingestion in the background; the dashboard polls `GET /api/jobs/:id`.
Stages: `queued → acquiring → parsing → authors → done` (or `error`).

1. **Acquire** (`src/git/acquire.ts`)
   - URL: `git clone` (full history — no `--depth`).
   - Zip: entries are extracted with zip-slip protection, and the worktree is
     located by scanning for `.git` as a directory *or* a `gitdir:` file, at
     the root or one nesting level deep (the usual repo-zip shape).
2. **Parse** (`src/git/logParser.ts`) — the command is

   ```
   git log HEAD --no-merges -M50% -z --numstat
          --format=%x1e%H%x1f%an%x1f%ae%x1f%ct%x1f%s
   ```

   streamed as NUL-delimited tokens. Commit headers are introduced by `\x1e`
   and split on `\x1f`. The parser attributes rename changes to the *new*
   path, skips binary files (`-  -`), skips pure 0/0 renames, and handles
   paths containing tabs, newlines and a literal `x => y.txt`. See
   `test/logParser.test.ts` for the byte-level contract.
3. **Store** (`src/git/ingest.ts`) — rows are inserted in batches of 1000
   commits inside one transaction each, which keeps memory flat for the
   100k-commit tier. Directory rollups (`src/git/rollup.ts`) are computed from
   the same rename-resolved paths at write time so files and directories are
   always temporally consistent.
4. **Authors** (`src/authors/`) — distinct `(name, email)` identities from the
   parsed commits are folded through the repository's `.mailmap` and mapped to
   canonical authors via an alias table.

Any failure deletes the repository row (foreign keys cascade to commits and
change rows) and removes the extracted worktree, so failed uploads leave no
partial data.

## Why this schema

- **`commits` is the centre of the star.** `file_changes` and `dir_changes`
  hold one row per commit × object; every metric is a
  `SUM`/`COUNT` + `GROUP BY` over these tables restricted to the commit set.
- **`WITHOUT ROWID` + covering indexes** (`(repo_id, path)` on change tables,
  `(repo_id, committer_ts)` on commits) make the common group-by scans
  index-ordered and keep the database compact.
- **`dir_changes` is pre-aggregated** at ingestion: one row per commit ×
  ancestor directory (including `/`). Directory metrics are then identical in
  shape to file metrics, and repository metrics are simply the `/` row.
- **Growth and churn are never stored** — they derive trivially and storing
  them would double the write path.
- **Author merging is metadata-only.** `author_aliases` maps every commit's
  identity to a canonical author, so merging/splitting authors is an
  `UPDATE` of alias pointers — no metric is ever recomputed.

## Query semantics

All metric endpoints share one commit-set filter
(`src/metrics/queries.ts`, `commitSetWhere`):

- `since` / `until` / `commits` / `authorId` narrow **H itself**
  (H_i,j time windows use the *committer* date; `since` is inclusive,
  `until` exclusive).
- `path` scopes **the measured objects only** — it never narrows H, so the
  denominators of η and ρ stay meaningful.

Explicit commit subsets are chunked into `IN (…)` groups of 500 to stay under
SQLite's variable limit.

## API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/repos` | list repositories |
| GET | `/api/repos/:id` | repository detail (+ author count) |
| POST | `/api/repos/url` | `{ url, name? }` → `202 { jobId }` |
| POST | `/api/repos/upload` | multipart `file` (zip) + `name?` → `202 { jobId }` |
| DELETE | `/api/repos/:id` | delete repo + stored worktree |
| GET | `/api/repos/:id/commits` | paged commit list for the commit picker |
| GET | `/api/repos/:id/authors` | canonical authors with aliases |
| POST | `/api/repos/:id/authors/merge` | `{ targetId, sourceIds }` |
| POST | `/api/repos/:id/authors/unmerge` | `{ name, email }` |
| GET | `/api/repos/:id/metrics/files` | file metrics (sort, limit) |
| GET | `/api/repos/:id/metrics/dirs` | directory metrics |
| GET | `/api/repos/:id/metrics/repository` | repository metrics |
| GET | `/api/repos/:id/metrics/authors` | author metrics |
| GET | `/api/repos/:id/timeline` | churn timeline (`bucket=day\|week\|month`) |
| GET | `/api/jobs`, `/api/jobs/:id` | ingestion job progress |

All metric endpoints accept the shared filter query parameters:
`since`, `until`, `commits` (comma-separated hashes), `authorId`, `path`.

## Performance notes

- Ingestion streams: peak memory is one 1000-commit batch, not the history.
- SQLite runs in WAL mode with `synchronous=NORMAL` and a 64 MB page cache;
  bulk inserts happen inside transactions.
- Group-by queries are index-covered; `LIMIT` caps every response
  (max 1000 rows) and the dashboard sorts/paginates client-side.
- The heavy path — `git log` itself — is a single native process; nothing in
  JavaScript touches the object database.

## Testing

`server/test/` (vitest, in-memory SQLite):

- `logParser.test.ts` — byte-level parser contract.
- `mailmap.test.ts` — the four mailmap forms and matching rules.
- `queries.test.ts` — every metric query against a hand-computed fixture.
- `e2e.test.ts` — builds a real git fixture (renames, merges, binary,
  mailmap, deletion, pinned committer dates) and drives the whole stack
  through `app.inject`, including the zip-upload path and error cleanup.
