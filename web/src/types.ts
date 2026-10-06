/**
 * API DTOs — mirrors `server/src/types.ts`. Keep both files in sync when the
 * API contract changes.
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

export interface MetricRow {
  path: string;
  added: number;
  removed: number;
  growth: number;
  churn: number;
  modifications: number;
  frequency: number;
  churnRate: number;
}

export interface MetricsResponse {
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

/**
 * Client-side filter state. `since`/`until`/`commits`/`authorId` narrow the
 * commit set H itself; `path` scopes the measured objects only.
 */
export interface CommitFilter {
  since?: number;
  until?: number;
  commits?: string[];
  authorId?: number;
  path?: string;
}
