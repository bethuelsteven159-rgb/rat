# RAT — Repo Analysis Tool

RAT is a web dashboard that ingests git repositories and computes the metrics
defined in the COMS3011A project brief: per **file**, per **directory**, per
**repository**, per **commit set** and per **author**.

- **Backend** — Node.js + Fastify + SQLite (better-sqlite3). Repositories are
  acquired by cloning a remote URL or extracting an uploaded zip that contains
  a `.git`, then the full history is streamed through `git log` into the
  database.
- **Frontend** — React + Vite + ECharts. Filter by repository, author, path,
  time window or a manually selected commit list; every metric view updates
  live.

## Quick start

Requirements: Node.js ≥ 18, npm ≥ 9, git ≥ 2.30 (rename detection with `-M50%`).

```bash
npm install          # installs both workspaces (server + web)
npm run dev          # API on :4000, dashboard on :5173 (proxies /api)
```

Then open http://localhost:5173, paste a repository URL (https://… or a local
path) or upload a zip of a repository, and watch the job in the sidebar until
it turns `ready`.

Useful repositories to try: `https://github.com/DaveGamble/cJSON`,
`https://github.com/redis/redis` (big — the 100k-commit performance tier), or
`https://github.com/git/git`.

## Scripts

| Command (repo root) | What it does |
| --- | --- |
| `npm run dev` | server (`tsx watch`) + web (`vite`) concurrently |
| `npm test` | server test suite (vitest): parser, mailmap, queries, end-to-end |
| `npm run typecheck` | TypeScript project checks for both workspaces |
| `npm run build` | typecheck server + production build of the web app |

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `RAT_PORT` | `4000` | API server port; the web dev server proxies `/api` to it |
| `RAT_DATA_DIR` | `./data` | Holds `rat.db` and the cloned/extracted repositories |

## Layout

```
server/            Fastify API + ingestion + metric queries
  src/db/          SQLite schema (star schema around commits)
  src/git/         git plumbing, log parser, acquisition, ingestion pipeline
  src/authors/     .mailmap parsing and the canonical-author model
  src/metrics/     every metric query (the heart of the brief)
  src/routes/      REST endpoints
  test/            vitest suites incl. an end-to-end fixture repository
web/               React + Vite + ECharts dashboard
docs/              architecture and metric-semantics documentation
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how ingestion and queries
  work, and why the schema looks the way it does.
- [`docs/metrics.md`](docs/metrics.md) — precise metric definitions and every
  edge case (renames, merges, binary files, deletions, author merging).

## Development notes

- The git-log parser is byte-level and covered by unit tests derived from
  real `git log -z --numstat` output — change `src/git/logParser.ts` with care.
- `server/src/types.ts` and `web/src/types.ts` mirror each other; keep them in
  sync when the API contract changes.
- Database artifacts live under `RAT_DATA_DIR` and are never committed
  (see `.gitignore`).
