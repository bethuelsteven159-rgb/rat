import type { FastifyReply } from 'fastify';
import type { DB } from '../db/database';
import type { CommitSetFilter } from '../metrics/queries';
import type { RepoSummary } from '../types';

const MAX_COMMITS = 10_000;

const REPO_COLUMNS = `
  id, name, status, source_type AS sourceType, source_ref AS sourceRef,
  head_hash AS headHash, head_subject AS headSubject, ingested_at AS ingestedAt,
  commit_count AS commitCount, file_count AS fileCount, dir_count AS dirCount,
  first_ts AS firstTs, last_ts AS lastTs
`;

export function findRepo(db: DB, id: number): RepoSummary | undefined {
  return db.prepare(`SELECT ${REPO_COLUMNS} FROM repositories WHERE id = ?`).get(id) as
    | RepoSummary
    | undefined;
}

export function replyError(reply: FastifyReply, code: number, message: string): unknown {
  return reply.code(code).send({ error: message });
}

/**
 * Parses the shared metric query parameters into a commit-set filter.
 * `path` is returned separately: it scopes the measured objects, not H.
 */
export function parseMetricFilter(
  query: Record<string, string | undefined>,
): { filter: CommitSetFilter; path?: string } | { error: string } {
  const filter: CommitSetFilter = {};

  if (query.since !== undefined && query.since !== '') {
    const since = Number(query.since);
    if (!Number.isFinite(since)) return { error: '"since" must be a unix timestamp' };
    filter.since = since;
  }
  if (query.until !== undefined && query.until !== '') {
    const until = Number(query.until);
    if (!Number.isFinite(until)) return { error: '"until" must be a unix timestamp' };
    filter.until = until;
  }
  if (query.commits !== undefined && query.commits !== '') {
    const hashes = query.commits.split(',').map((h) => h.trim()).filter(Boolean);
    if (hashes.length === 0) return { error: '"commits" must be comma-separated hashes' };
    if (hashes.length > MAX_COMMITS) {
      return { error: `Too many commits selected (max ${MAX_COMMITS})` };
    }
    filter.commits = hashes;
  }
  if (query.authorId !== undefined && query.authorId !== '') {
    const authorId = Number(query.authorId);
    if (!Number.isInteger(authorId)) return { error: '"authorId" must be an integer' };
    filter.authorId = authorId;
  }

  const path = query.path?.trim();
  return { filter, path: path || undefined };
}
