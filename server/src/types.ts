/**
 * DTOs returned by the REST API.
 *
 * The web app mirrors these shapes in `web/src/types.ts` — keep them in sync
 * when changing the API contract.
 */

export type RepoStatus = 'ingesting' | 'ready' | 'error';

export interface RepoSummary {
  id: number;
  name: string;
  status: RepoStatus;
  sourceType: 'url' | 'zip';
  sourceRef: string | null;
  headHash: string;
  headSubject: string | null;
  ingestedAt: string;
  commitCount: number;
  fileCount: number;
  dirCount: number;
  firstTs: number | null;
  lastTs: number | null;
  authorCount?: number;
}

export interface JobView {
  id: string;
  repoName: string;
  stage: 'queued' | 'acquiring' | 'parsing' | 'authors' | 'done' | 'error';
  commits: number;
  files: number;
  error?: string;
  repoId?: number;
}

/** One object (file or directory) with every metric from the brief. */
export interface MetricRow {
  path: string;
  /** l+ : total lines added over the commit set. */
  added: number;
  /** l- : total lines removed over the commit set. */
  removed: number;
  /** delta = l+ - l- */
  growth: number;
  /** lambda = l+ + l- */
  churn: number;
  /** n : number of commits with churn > 0 on this object. */
  modifications: number;
  /** eta = n / |H| */
  frequency: number;
  /** rho = lambda / |H| */
  churnRate: number;
}

export interface MetricsResponse {
  /** |H| : size of the currently filtered commit set. */
  commitSetSize: number;
  rows: MetricRow[];
}

export interface RepositoryMetrics {
  commitSetSize: number;
  authorCount: number;
  added: number;
  removed: number;
  growth: number;
  churn: number;
  modifications: number;
  firstTs: number | null;
  lastTs: number | null;
}

export interface AuthorMetric {
  authorId: number;
  name: string;
  email: string;
  added: number;
  removed: number;
  growth: number;
  churn: number;
  modifications: number;
  /** omega = author churn / total churn (0 when total churn is 0). */
  ownership: number;
}

export interface AuthorsMetricsResponse {
  commitSetSize: number;
  rows: AuthorMetric[];
}

export interface TimelinePoint {
  bucket: string;
  commits: number;
  added: number;
  removed: number;
  growth: number;
}

export interface CommitListItem {
  hash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  committerTs: number;
}

export interface AliasView {
  name: string;
  email: string;
  source: 'identity' | 'mailmap' | 'manual';
}

export interface AuthorView {
  id: number;
  name: string;
  email: string;
  commitCount: number;
  firstTs: number | null;
  lastTs: number | null;
  aliases: AliasView[];
}
