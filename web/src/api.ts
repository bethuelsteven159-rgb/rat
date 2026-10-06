import type {
  AuthorMetric,
  AuthorView,
  CommitFilter,
  CommitListItem,
  JobView,
  MetricRow,
  RepoSummary,
  RepositoryMetrics,
  TimelinePoint,
} from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

function buildQuery(filter: CommitFilter, extra: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  if (filter.since !== undefined) params.set('since', String(filter.since));
  if (filter.until !== undefined) params.set('until', String(filter.until));
  if (filter.commits !== undefined && filter.commits.length > 0) {
    params.set('commits', filter.commits.join(','));
  }
  if (filter.authorId !== undefined) params.set('authorId', String(filter.authorId));
  if (filter.path) params.set('path', filter.path);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const api = {
  listRepos: (): Promise<RepoSummary[]> => fetch('/api/repos').then(json<RepoSummary[]>),

  addRepoByUrl: (url: string, name?: string): Promise<{ jobId: string }> =>
    post('/api/repos/url', { url, name }).then(json<{ jobId: string }>),

  uploadRepoZip: (file: File, name?: string): Promise<{ jobId: string }> => {
    const body = new FormData();
    body.append('file', file);
    if (name !== undefined) body.append('name', name);
    return fetch('/api/repos/upload', { method: 'POST', body }).then(json<{ jobId: string }>);
  },

  deleteRepo: async (id: number): Promise<void> => {
    const res = await fetch(`/api/repos/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  },

  listJobs: (): Promise<{ jobs: JobView[] }> => fetch('/api/jobs').then(json<{ jobs: JobView[] }>),

  fileMetrics: (
    id: number,
    filter: CommitFilter,
  ): Promise<{ commitSetSize: number; rows: MetricRow[] }> =>
    fetch(`/api/repos/${id}/metrics/files${buildQuery(filter, { limit: 200 })}`).then(
      json<{ commitSetSize: number; rows: MetricRow[] }>,
    ),

  dirMetrics: (
    id: number,
    filter: CommitFilter,
  ): Promise<{ commitSetSize: number; rows: MetricRow[] }> =>
    fetch(`/api/repos/${id}/metrics/dirs${buildQuery(filter, { limit: 500 })}`).then(
      json<{ commitSetSize: number; rows: MetricRow[] }>,
    ),

  repositoryMetrics: (id: number, filter: CommitFilter): Promise<RepositoryMetrics> =>
    fetch(`/api/repos/${id}/metrics/repository${buildQuery(filter, {})}`).then(
      json<RepositoryMetrics>,
    ),

  authorMetrics: (
    id: number,
    filter: CommitFilter,
  ): Promise<{ commitSetSize: number; rows: AuthorMetric[] }> =>
    fetch(`/api/repos/${id}/metrics/authors${buildQuery(filter, { limit: 200 })}`).then(
      json<{ commitSetSize: number; rows: AuthorMetric[] }>,
    ),

  timeline: (
    id: number,
    filter: CommitFilter,
    bucket: 'day' | 'week' | 'month',
  ): Promise<{ points: TimelinePoint[] }> =>
    fetch(`/api/repos/${id}/timeline${buildQuery(filter, { bucket })}`).then(
      json<{ points: TimelinePoint[] }>,
    ),

  listCommits: (
    id: number,
    filter: CommitFilter,
    limit: number,
    offset: number,
  ): Promise<{ total: number; commits: CommitListItem[] }> =>
    fetch(`/api/repos/${id}/commits${buildQuery(filter, { limit, offset })}`).then(
      json<{ total: number; commits: CommitListItem[] }>,
    ),

  listAuthors: (id: number): Promise<{ authors: AuthorView[] }> =>
    fetch(`/api/repos/${id}/authors`).then(json<{ authors: AuthorView[] }>),

  mergeAuthors: (
    id: number,
    targetId: number,
    sourceIds: number[],
  ): Promise<{ authors: AuthorView[] }> =>
    post(`/api/repos/${id}/authors/merge`, { targetId, sourceIds }).then(
      json<{ authors: AuthorView[] }>,
    ),

  unmergeAuthor: (id: number, name: string, email: string): Promise<{ authors: AuthorView[] }> =>
    post(`/api/repos/${id}/authors/unmerge`, { name, email }).then(
      json<{ authors: AuthorView[] }>,
    ),
};
