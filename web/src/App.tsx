import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { AuthorsPanel } from './components/AuthorsPanel';
import { CommitsView } from './components/CommitsView';
import { FilterBar } from './components/FilterBar';
import { MetricsTable } from './components/MetricsTable';
import { Overview } from './components/Overview';
import { RepoSidebar } from './components/RepoSidebar';
import { TimelineView } from './components/TimelineView';
import type { AuthorView, CommitFilter, JobView, RepoSummary } from './types';

type View = 'overview' | 'files' | 'dirs' | 'authors' | 'timeline' | 'commits';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'dirs', label: 'Directories' },
  { id: 'authors', label: 'Authors' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'commits', label: 'Commits' },
];

export default function App() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [repoId, setRepoId] = useState<number | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [authors, setAuthors] = useState<AuthorView[]>([]);
  const [view, setView] = useState<View>('overview');
  const [filter, setFilter] = useState<CommitFilter>({});

  const repo = repos.find((r) => r.id === repoId) ?? null;

  const refresh = useCallback(async () => {
    const [{ jobs: currentJobs }, currentRepos] = await Promise.all([api.listJobs(), api.listRepos()]);
    setJobs(currentJobs);
    setRepos(currentRepos);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep polling while any ingestion job is still running.
  const busy = jobs.some((j) => j.stage !== 'done' && j.stage !== 'error');
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  // Select a ready repository automatically once one exists.
  useEffect(() => {
    if (repos.length === 0) return;
    if (repoId === null || !repos.some((r) => r.id === repoId)) {
      const first = repos.find((r) => r.status === 'ready') ?? repos[0];
      if (first) setRepoId(first.id);
    }
  }, [repos, repoId]);

  // Author list for the filter dropdown; refreshed after merges too.
  const refreshAuthors = useCallback(async () => {
    if (repo?.status !== 'ready') {
      setAuthors([]);
      return;
    }
    setAuthors((await api.listAuthors(repo.id)).authors);
  }, [repo?.id, repo?.status]);

  useEffect(() => {
    void refreshAuthors();
  }, [refreshAuthors]);

  // |H| for the filter bar, independent of the active view.
  const [commitSetSize, setCommitSetSize] = useState<number | null>(null);
  useEffect(() => {
    if (repo?.status !== 'ready') {
      setCommitSetSize(null);
      return;
    }
    let alive = true;
    api
      .listCommits(repo.id, filter, 1, 0)
      .then((page) => {
        if (alive) setCommitSetSize(page.total);
      })
      .catch(() => {
        if (alive) setCommitSetSize(null);
      });
    return () => {
      alive = false;
    };
  }, [repo?.id, repo?.status, filter]);

  const patchFilter = useCallback((patch: Partial<CommitFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
  }, []);

  return (
    <div className="app">
      <RepoSidebar
        repos={repos}
        jobs={jobs}
        selectedId={repoId}
        onSelect={setRepoId}
        onChanged={refresh}
      />
      <main className="main">
        {repo === null ? (
          <div className="empty">
            <h2>No repository selected</h2>
            <p>Add a git URL or upload a repository zip to get started.</p>
          </div>
        ) : (
          <>
            <header className="repo-header">
              <div className="repo-title">
                <h1>{repo.name}</h1>
                <p className="repo-meta">
                  {repo.headSubject ?? '—'} · {repo.commitCount.toLocaleString()} commits ·{' '}
                  {repo.fileCount.toLocaleString()} files · {repo.dirCount.toLocaleString()} dirs
                </p>
              </div>
              <nav className="tabs">
                {VIEWS.map((v) => (
                  <button
                    key={v.id}
                    className={view === v.id ? 'tab active' : 'tab'}
                    onClick={() => setView(v.id)}
                  >
                    {v.label}
                  </button>
                ))}
              </nav>
            </header>
            {repo.status !== 'ready' ? (
              <div className="empty">
                <h2>Ingesting repository…</h2>
                <p>Jobs are shown in the sidebar; this page fills in once parsing completes.</p>
              </div>
            ) : (
              <>
                <FilterBar
                  authors={authors}
                  filter={filter}
                  onChange={patchFilter}
                  commitSetSize={commitSetSize}
                />
                {view === 'overview' && <Overview repoId={repo.id} filter={filter} />}
                {view === 'files' && (
                  <MetricsTable
                    repoId={repo.id}
                    filter={filter}
                    kind="file"
                    onDrillDown={(path) => patchFilter({ path })}
                  />
                )}
                {view === 'dirs' && (
                  <MetricsTable
                    repoId={repo.id}
                    filter={filter}
                    kind="dir"
                    onDrillDown={(path) => patchFilter({ path })}
                  />
                )}
                {view === 'authors' && (
                  <AuthorsPanel
                    repoId={repo.id}
                    filter={filter}
                    onAuthorsChanged={refreshAuthors}
                  />
                )}
                {view === 'timeline' && <TimelineView repoId={repo.id} filter={filter} />}
                {view === 'commits' && (
                  <CommitsView repoId={repo.id} filter={filter} onChange={patchFilter} />
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
