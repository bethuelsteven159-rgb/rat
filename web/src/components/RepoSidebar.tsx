import { useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { JobView, RepoSummary } from '../types';

interface Props {
  repos: RepoSummary[];
  jobs: JobView[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onChanged: () => void;
}

export function RepoSidebar({ repos, jobs, selectedId, onSelect, onChanged }: Props) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [zipName, setZipName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addByUrl = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    try {
      await api.addRepoByUrl(url.trim(), name.trim() || undefined);
      setUrl('');
      setName('');
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const uploadZip = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    try {
      await api.uploadRepoZip(file, zipName.trim() || undefined);
      setZipName('');
      if (fileInput.current) fileInput.current.value = '';
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (repo: RepoSummary) => {
    if (!window.confirm(`Delete repository "${repo.name}" and all its ingested data?`)) return;
    try {
      await api.deleteRepo(repo.id);
      setError(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <aside className="sidebar">
      <h1 className="brand">RAT</h1>
      <p className="tagline">Repo Analysis Tool</p>

      <section className="panel">
        <h2>Add repository</h2>
        <form onSubmit={addByUrl}>
          <input
            placeholder="git URL or local path"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input
            placeholder="name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit">Clone &amp; ingest</button>
        </form>
        <div className="upload">
          <input ref={fileInput} type="file" accept=".zip" />
          <input
            placeholder="name (optional)"
            value={zipName}
            onChange={(e) => setZipName(e.target.value)}
          />
          <button type="button" onClick={() => void uploadZip()}>
            Upload zip
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <h2>Repositories</h2>
        <ul className="repo-list">
          {repos.map((repo) => (
            <li key={repo.id} className={repo.id === selectedId ? 'selected' : ''}>
              <button
                className="repo-button"
                onClick={() => onSelect(repo.id)}
                title={repo.sourceRef ?? undefined}
              >
                <span className="repo-name">{repo.name}</span>
                <span className={`status status-${repo.status}`}>{repo.status}</span>
                <span className="repo-count">{repo.commitCount.toLocaleString()} commits</span>
              </button>
              <button
                className="icon-button"
                title="Delete repository"
                onClick={() => void remove(repo)}
              >
                ×
              </button>
            </li>
          ))}
          {repos.length === 0 && <li className="hint">None yet.</li>}
        </ul>
      </section>

      {jobs.length > 0 && (
        <section className="panel">
          <h2>Jobs</h2>
          <ul className="job-list">
            {jobs
              .slice(-8)
              .reverse()
              .map((job) => (
                <li key={job.id}>
                  <span className="job-name">{job.repoName}</span>
                  <span className={`status status-${job.stage}`}>{job.stage}</span>
                  {job.stage === 'error' ? (
                    <span className="error" title={job.error}>
                      failed
                    </span>
                  ) : (
                    <span className="job-count">{job.commits.toLocaleString()} commits</span>
                  )}
                </li>
              ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
