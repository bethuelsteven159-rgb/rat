import { useState } from 'react';
import { api } from '../api';
import { fmtDateTime, fmtInt } from '../format';
import { useAsync } from '../hooks';
import type { CommitFilter } from '../types';

const PAGE_SIZE = 100;

interface Props {
  repoId: number;
  filter: CommitFilter;
  onChange: (patch: Partial<CommitFilter>) => void;
}

/** Paged commit browser; checked rows build the manual commit-set filter. */
export function CommitsView({ repoId, filter, onChange }: Props) {
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useAsync(
    () => api.listCommits(repoId, filter, PAGE_SIZE, offset),
    [repoId, filter, offset],
  );

  const selected = new Set(filter.commits ?? []);
  const toggle = (hash: string) => {
    if (selected.has(hash)) selected.delete(hash);
    else selected.add(hash);
    onChange({ commits: selected.size > 0 ? Array.from(selected) : undefined });
  };

  const total = data?.total ?? 0;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section>
      <div className="toolbar">
        <span className="commit-count">
          {selected.size > 0 && `${selected.size} commits selected · `}
          |H| = {fmtInt(total)}
        </span>
        {selected.size > 0 && (
          <button className="ghost" onClick={() => onChange({ commits: undefined })}>
            clear selection
          </button>
        )}
        <span className="spacer" />
        <button
          className="ghost"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          ← newer
        </button>
        <span className="hint">
          page {page} / {pages}
        </span>
        <button
          className="ghost"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          older →
        </button>
      </div>
      {loading && <p className="hint">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data !== null && (
        <table className="metrics-table commits-table">
          <thead>
            <tr>
              <th className="check" />
              <th>committer date</th>
              <th>author</th>
              <th>subject</th>
              <th>hash</th>
            </tr>
          </thead>
          <tbody>
            {data.commits.map((commit) => (
              <tr key={commit.hash} className={selected.has(commit.hash) ? 'picked' : ''}>
                <td className="check">
                  <input
                    type="checkbox"
                    checked={selected.has(commit.hash)}
                    onChange={() => toggle(commit.hash)}
                  />
                </td>
                <td className="num">{fmtDateTime(commit.committerTs)}</td>
                <td title={commit.authorEmail}>{commit.authorName}</td>
                <td>{commit.subject}</td>
                <td className="hash">{commit.hash.slice(0, 10)}</td>
              </tr>
            ))}
            {data.commits.length === 0 && (
              <tr>
                <td colSpan={5} className="hint">
                  No commits match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
