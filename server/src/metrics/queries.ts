import type { DB } from '../db/database';
import type {
  AuthorMetric,
  CommitListItem,
  MetricRow,
  RepositoryMetrics,
  TimelinePoint,
} from '../types';

/**
 * Commit-set filter shared by every metric query.
 *
 * Semantics (see docs/metrics.md):
 * - `since`/`until`/`commits`/`authorId` narrow the commit set H itself
 *   (H_i,j windows, explicit subsets, authorship).
 * - A `pathPrefix` narrows the *objects* being measured, not H.
 */
export interface CommitSetFilter {
  /** Inclusive lower bound on committer date (H_i). */
  since?: number;
  /** Exclusive upper bound on committer date (H_j). */
  until?: number;
  /** Explicit commit subset (hashes). */
  commits?: string[];
  /** Canonical author id (post-merge). */
  authorId?: number;
}

/** Resolves every commit's identity to its canonical author. */
const AUTHOR_JOIN =
  'JOIN author_aliases aa ON aa.repo_id = c.repo_id AND aa.alias_name = c.author_name AND aa.alias_email = c.author_email';

interface SqlParts {
  where: string;
  params: unknown[];
}

function commitSetWhere(repoId: number, filter: CommitSetFilter): SqlParts {
  const conditions: string[] = ['c.repo_id = ?'];
  const params: unknown[] = [repoId];
  if (filter.since !== undefined) {
    conditions.push('c.committer_ts >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push('c.committer_ts < ?');
    params.push(filter.until);
  }
  if (filter.commits && filter.commits.length > 0) {
    // Chunked IN groups stay within SQLite's variable limit.
    const groups: string[] = [];
    for (let i = 0; i < filter.commits.length; i += 500) {
      const chunk = filter.commits.slice(i, i + 500);
      groups.push(`c.hash IN (${chunk.map(() => '?').join(', ')})`);
      params.push(...chunk);
    }
    conditions.push(`(${groups.join(' OR ')})`);
  }
  if (filter.authorId !== undefined) {
    conditions.push('aa.canonical_id = ?');
    params.push(filter.authorId);
  }
  return { where: conditions.join(' AND '), params };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/** `path = X OR path LIKE 'X/%'` with proper LIKE escaping. */
function subtreeCondition(pathPrefix: string): { sql: string; params: unknown[] } {
  return {
    sql: "(x.path = ? OR x.path LIKE ? ESCAPE '\\')",
    params: [pathPrefix, `${escapeLike(pathPrefix)}/%`],
  };
}

/** |H| — the size of the (possibly filtered) commit set. */
export function commitSetSize(db: DB, repoId: number, filter: CommitSetFilter): number {
  const { where, params } = commitSetWhere(repoId, filter);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM commits c ${AUTHOR_JOIN} WHERE ${where}`)
    .get(...params) as { n: number };
  return row.n;
}

const SORT_EXPRESSIONS: Record<string, string> = {
  churn: '(SUM(x.added) + SUM(x.removed))',
  added: 'SUM(x.added)',
  removed: 'SUM(x.removed)',
  growth: '(SUM(x.added) - SUM(x.removed))',
  modifications: 'COUNT(*)',
  path: 'x.path',
};

export type ObjectKind = 'file' | 'dir';

export interface ObjectMetricsOptions {
  kind: ObjectKind;
  pathPrefix?: string;
  sort?: string;
  limit?: number;
}

/**
 * File or directory metrics over the commit set:
 * l+, l-, n directly; delta/lambda/eta/rho derived (see toMetricRow).
 */
export function objectMetrics(
  db: DB,
  repoId: number,
  filter: CommitSetFilter,
  options: ObjectMetricsOptions,
): { commitSetSize: number; rows: MetricRow[] } {
  const table = options.kind === 'file' ? 'file_changes' : 'dir_changes';
  const { where, params } = commitSetWhere(repoId, filter);

  const conditions = [where];
  if (options.pathPrefix) {
    const subtree = subtreeCondition(options.pathPrefix);
    conditions.push(subtree.sql);
    params.push(...subtree.params);
  }

  const sortKey = options.sort && SORT_EXPRESSIONS[options.sort] ? options.sort : 'churn';
  const sortExpr = SORT_EXPRESSIONS[sortKey]!;
  const direction = sortKey === 'path' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);

  const rows = db
    .prepare(
      `SELECT x.path AS path,
              SUM(x.added) AS added,
              SUM(x.removed) AS removed,
              COUNT(*) AS modifications
         FROM ${table} x
         JOIN commits c ON c.repo_id = x.repo_id AND c.hash = x.commit_hash
         ${AUTHOR_JOIN}
        WHERE ${conditions.join(' AND ')}
        GROUP BY x.path
        ORDER BY ${sortExpr} ${direction}
        LIMIT ${limit}`,
    )
    .all(...params) as Array<{ path: string; added: number; removed: number; modifications: number }>;

  const size = commitSetSize(db, repoId, filter);
  return { commitSetSize: size, rows: rows.map(toMetricRow(size)) };
}

function toMetricRow(size: number) {
  return (row: {
    path: string;
    added: number;
    removed: number;
    modifications: number;
  }): MetricRow => {
    const churn = row.added + row.removed;
    return {
      path: row.path,
      added: row.added,
      removed: row.removed,
      growth: row.added - row.removed,
      churn,
      modifications: row.modifications,
      frequency: size > 0 ? row.modifications / size : 0,
      churnRate: size > 0 ? churn / size : 0,
    };
  };
}

/**
 * Repository metrics: directory metrics on the root. With a pathPrefix the
 * subtree replaces the root as the measured object (same numbers the dir
 * rollup would give, computed straight from file rows).
 */
export function repositoryMetrics(
  db: DB,
  repoId: number,
  filter: CommitSetFilter,
  pathPrefix?: string,
): RepositoryMetrics {
  const { where, params } = commitSetWhere(repoId, filter);

  let added: number;
  let removed: number;
  let modifications: number;
  if (pathPrefix) {
    const subtree = subtreeCondition(pathPrefix);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(x.added), 0) AS added,
                COALESCE(SUM(x.removed), 0) AS removed,
                COUNT(*) AS modifications
           FROM file_changes x
           JOIN commits c ON c.repo_id = x.repo_id AND c.hash = x.commit_hash
           ${AUTHOR_JOIN}
          WHERE ${where} AND ${subtree.sql}`,
      )
      .get(...params, ...subtree.params) as { added: number; removed: number; modifications: number };
    ({ added, removed, modifications } = row);
  } else {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(x.added), 0) AS added,
                COALESCE(SUM(x.removed), 0) AS removed,
                COUNT(*) AS modifications
           FROM dir_changes x
           JOIN commits c ON c.repo_id = x.repo_id AND c.hash = x.commit_hash
           ${AUTHOR_JOIN}
          WHERE ${where} AND x.path = '/'`,
      )
      .get(...params) as { added: number; removed: number; modifications: number };
    ({ added, removed, modifications } = row);
  }

  const meta = db
    .prepare(
      `SELECT COUNT(DISTINCT aa.canonical_id) AS authorCount,
              MIN(c.committer_ts) AS firstTs,
              MAX(c.committer_ts) AS lastTs
         FROM commits c
         ${AUTHOR_JOIN}
        WHERE ${where}`,
    )
    .get(...params) as { authorCount: number; firstTs: number | null; lastTs: number | null };

  return {
    commitSetSize: commitSetSize(db, repoId, filter),
    authorCount: meta.authorCount,
    added,
    removed,
    growth: added - removed,
    churn: added + removed,
    modifications,
    firstTs: meta.firstTs,
    lastTs: meta.lastTs,
  };
}

/** Author metrics over the commit set (optionally scoped to a path subtree). */
export function authorMetrics(
  db: DB,
  repoId: number,
  filter: CommitSetFilter,
  pathPrefix?: string,
  limit = 100,
): { commitSetSize: number; rows: AuthorMetric[] } {
  const { where, params } = commitSetWhere(repoId, filter);

  const conditions = [where];
  if (pathPrefix) {
    const subtree = subtreeCondition(pathPrefix);
    conditions.push(subtree.sql);
    params.push(...subtree.params);
  }

  const rows = db
    .prepare(
      `SELECT ca.id AS authorId,
              ca.name AS name,
              ca.email AS email,
              SUM(x.added) AS added,
              SUM(x.removed) AS removed,
              COUNT(DISTINCT x.commit_hash) AS modifications
         FROM file_changes x
         JOIN commits c ON c.repo_id = x.repo_id AND c.hash = x.commit_hash
         ${AUTHOR_JOIN}
         JOIN canonical_authors ca ON ca.id = aa.canonical_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY ca.id
        ORDER BY (SUM(x.added) + SUM(x.removed)) DESC
        LIMIT ${Math.min(Math.max(limit, 1), 1000)}`,
    )
    .all(...params) as Array<{
    authorId: number;
    name: string;
    email: string;
    added: number;
    removed: number;
    modifications: number;
  }>;

  const totalChurn = rows.reduce((sum, row) => sum + row.added + row.removed, 0);
  return {
    commitSetSize: commitSetSize(db, repoId, filter),
    rows: rows.map((row) => ({
      authorId: row.authorId,
      name: row.name,
      email: row.email,
      added: row.added,
      removed: row.removed,
      growth: row.added - row.removed,
      churn: row.added + row.removed,
      modifications: row.modifications,
      ownership: totalChurn > 0 ? (row.added + row.removed) / totalChurn : 0,
    })),
  };
}

export type TimelineBucket = 'day' | 'week' | 'month';

/** Churn timeline bucketed by committer date. */
export function timeline(
  db: DB,
  repoId: number,
  filter: CommitSetFilter,
  bucket: TimelineBucket = 'month',
  pathPrefix?: string,
): TimelinePoint[] {
  const format = bucket === 'day' ? '%Y-%m-%d' : bucket === 'week' ? '%Y-%W' : '%Y-%m';
  const { where, params } = commitSetWhere(repoId, filter);

  // Without a path scope every commit of H appears (LEFT JOIN, churn 0 for
  // empty commits); with one, only commits touching the subtree remain.
  const conditions = [where];
  let join =
    'LEFT JOIN file_changes x ON x.repo_id = c.repo_id AND x.commit_hash = c.hash';
  if (pathPrefix) {
    const subtree = subtreeCondition(pathPrefix);
    join = 'JOIN file_changes x ON x.repo_id = c.repo_id AND x.commit_hash = c.hash';
    conditions.push(subtree.sql);
    params.push(...subtree.params);
  }

  const rows = db
    .prepare(
      `SELECT strftime('${format}', c.committer_ts, 'unixepoch') AS bucket,
              COUNT(DISTINCT c.hash) AS commits,
              COALESCE(SUM(x.added), 0) AS added,
              COALESCE(SUM(x.removed), 0) AS removed
         FROM commits c
         ${AUTHOR_JOIN}
         ${join}
        WHERE ${conditions.join(' AND ')}
        GROUP BY bucket
        ORDER BY bucket`,
    )
    .all(...params) as Array<{ bucket: string; commits: number; added: number; removed: number }>;

  return rows.map((row) => ({
    bucket: row.bucket,
    commits: row.commits,
    added: row.added,
    removed: row.removed,
    growth: row.added - row.removed,
  }));
}

/** Paged commit list (for the manual commit-selection UI). */
export function listCommits(
  db: DB,
  repoId: number,
  filter: CommitSetFilter,
  limit = 100,
  offset = 0,
): { total: number; commits: CommitListItem[] } {
  const { where, params } = commitSetWhere(repoId, filter);
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM commits c ${AUTHOR_JOIN} WHERE ${where}`)
      .get(...params) as { n: number }
  ).n;
  const commits = db
    .prepare(
      `SELECT c.hash AS hash,
              c.subject AS subject,
              c.author_name AS authorName,
              c.author_email AS authorEmail,
              c.committer_ts AS committerTs
         FROM commits c
         ${AUTHOR_JOIN}
        WHERE ${where}
        ORDER BY c.committer_ts DESC, c.hash DESC
        LIMIT ${Math.min(Math.max(limit, 1), 1000)}
        OFFSET ${Math.max(offset, 0)}`,
    )
    .all(...params) as CommitListItem[];
  return { total, commits };
}

/** All canonical authors of a repo with their aliases and commit activity. */
export function listAuthors(
  db: DB,
  repoId: number,
): Array<{
  id: number;
  name: string;
  email: string;
  commitCount: number;
  firstTs: number | null;
  lastTs: number | null;
  aliases: Array<{ name: string; email: string; source: string }>;
}> {
  const authors = db
    .prepare(
      'SELECT id, name, email FROM canonical_authors WHERE repo_id = ? ORDER BY name',
    )
    .all(repoId) as Array<{ id: number; name: string; email: string }>;

  const stats = new Map(
    (
      db
        .prepare(
          `SELECT aa.canonical_id AS id,
                  COUNT(*) AS commitCount,
                  MIN(c.committer_ts) AS firstTs,
                  MAX(c.committer_ts) AS lastTs
             FROM commits c
             ${AUTHOR_JOIN}
            WHERE c.repo_id = ?
            GROUP BY aa.canonical_id`,
        )
        .all(repoId) as Array<{
        id: number;
        commitCount: number;
        firstTs: number | null;
        lastTs: number | null;
      }>
    ).map((row) => [row.id, row]),
  );

  const aliases = db
    .prepare(
      'SELECT canonical_id AS canonicalId, alias_name AS name, alias_email AS email, source FROM author_aliases WHERE repo_id = ?',
    )
    .all(repoId) as Array<{ canonicalId: number; name: string; email: string; source: string }>;

  const aliasesByCanonical = new Map<number, Array<{ name: string; email: string; source: string }>>();
  for (const alias of aliases) {
    const list = aliasesByCanonical.get(alias.canonicalId) ?? [];
    list.push({ name: alias.name, email: alias.email, source: alias.source });
    aliasesByCanonical.set(alias.canonicalId, list);
  }

  return authors.map((author) => {
    const stat = stats.get(author.id);
    return {
      ...author,
      commitCount: stat?.commitCount ?? 0,
      firstTs: stat?.firstTs ?? null,
      lastTs: stat?.lastTs ?? null,
      aliases: aliasesByCanonical.get(author.id) ?? [],
    };
  });
}

/** Merges source canonical authors into a target by re-pointing their aliases. */
export function mergeAuthors(
  db: DB,
  repoId: number,
  targetId: number,
  sourceIds: number[],
): void {
  const tx = db.transaction(() => {
    for (const sourceId of sourceIds) {
      db.prepare(
        'UPDATE author_aliases SET canonical_id = ? WHERE repo_id = ? AND canonical_id = ?',
      ).run(targetId, repoId, sourceId);
      db.prepare('DELETE FROM canonical_authors WHERE repo_id = ? AND id = ?').run(repoId, sourceId);
    }
  });
  tx();
}

/** Splits one identity back out into its own canonical author. */
export function unmergeAlias(
  db: DB,
  repoId: number,
  name: string,
  email: string,
): { ok: true } | { ok: false; reason: string } {
  const alias = db
    .prepare(
      'SELECT canonical_id AS canonicalId FROM author_aliases WHERE repo_id = ? AND alias_name = ? AND alias_email = ?',
    )
    .get(repoId, name, email) as { canonicalId: number } | undefined;
  if (!alias) return { ok: false, reason: 'Identity not found' };

  const others = (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM author_aliases WHERE repo_id = ? AND canonical_id = ? AND (alias_name != ? OR alias_email != ?)',
      )
      .get(repoId, alias.canonicalId, name, email) as { n: number }
  ).n;
  if (others === 0) return { ok: false, reason: 'Identity is already its own canonical author' };

  const tx = db.transaction(() => {
    const newId = Number(
      db
        .prepare('INSERT INTO canonical_authors (repo_id, name, email) VALUES (?, ?, ?)')
        .run(repoId, name, email).lastInsertRowid,
    );
    db.prepare(
      'UPDATE author_aliases SET canonical_id = ? WHERE repo_id = ? AND alias_name = ? AND alias_email = ?',
    ).run(newId, repoId, name, email);
  });
  tx();
  return { ok: true };
}
