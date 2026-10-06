import { useState } from 'react';
import { api } from '../api';
import { fmtInt } from '../format';
import { useAsync } from '../hooks';
import type { CommitFilter } from '../types';

interface Props {
  repoId: number;
  filter: CommitFilter;
  onAuthorsChanged: () => void;
}

/**
 * Author metrics with alias management: identities merged via .mailmap can be
 * merged/split manually at runtime; no recomputation is needed because every
 * commit resolves to its canonical author through the alias table.
 */
export function AuthorsPanel({ repoId, filter, onAuthorsChanged }: Props) {
  const [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);

  const authors = useAsync(async () => (await api.listAuthors(repoId)).authors, [repoId, version]);
  const metrics = useAsync(() => api.authorMetrics(repoId, filter), [repoId, filter, version]);

  const list = authors.data ?? [];
  const rows = metrics.data?.rows ?? [];
  const metricsById = new Map(rows.map((row) => [row.authorId, row]));

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const merge = async () => {
    const targetId = Number(target);
    const sourceIds = selected.filter((id) => id !== targetId);
    if (!Number.isInteger(targetId) || sourceIds.length === 0) return;
    try {
      await api.mergeAuthors(repoId, targetId, sourceIds);
      setSelected([]);
      setTarget('');
      setError(null);
      setVersion((v) => v + 1);
      onAuthorsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const unmerge = async (name: string, email: string) => {
    try {
      await api.unmergeAuthor(repoId, name, email);
      setError(null);
      setVersion((v) => v + 1);
      onAuthorsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section>
      <table className="metrics-table">
        <thead>
          <tr>
            <th className="check" />
            <th>author</th>
            <th>aliases</th>
            <th title="lines added">l+</th>
            <th title="lines removed">l−</th>
            <th title="growth = l+ − l−">δ</th>
            <th title="churn = l+ + l−">λ</th>
            <th title="modifications (commits with churn > 0)">n</th>
            <th title="ownership = λ / total λ">ω</th>
          </tr>
        </thead>
        <tbody>
          {list.map((author) => {
            const m = metricsById.get(author.id);
            return (
              <tr key={author.id}>
                <td className="check">
                  <input
                    type="checkbox"
                    checked={selected.includes(author.id)}
                    onChange={() => toggle(author.id)}
                  />
                </td>
                <td>
                  <strong>{author.name}</strong>
                  <div className="hint email">{author.email}</div>
                </td>
                <td>
                  {author.aliases.map((alias) => (
                    <span
                      key={`${alias.name} <${alias.email}>`}
                      className="alias"
                      title={`${alias.name} <${alias.email}> (${alias.source}) — remove × to unmerge`}
                    >
                      {alias.name !== author.name ? alias.name : alias.email}
                      <button
                        className="unmerge"
                        title="Split this identity back out"
                        onClick={() => void unmerge(alias.name, alias.email)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </td>
                <td className="num">{m ? fmtInt(m.added) : '—'}</td>
                <td className="num">{m ? fmtInt(m.removed) : '—'}</td>
                <td className="num">{m ? fmtInt(m.growth) : '—'}</td>
                <td className="num">{m ? fmtInt(m.churn) : '—'}</td>
                <td className="num">{m ? fmtInt(m.modifications) : '—'}</td>
                <td className="num">{m ? `${(m.ownership * 100).toFixed(1)}%` : '—'}</td>
              </tr>
            );
          })}
          {list.length === 0 && !authors.loading && (
            <tr>
              <td colSpan={9} className="hint">
                No authors yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="toolbar">
        <span className="hint">Merge identities of the same person:</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">merge selected into…</option>
          {list.map((author) => (
            <option key={author.id} value={author.id}>
              {author.name} &lt;{author.email}&gt;
            </option>
          ))}
        </select>
        <button
          className="ghost"
          disabled={target === '' || selected.length === 0}
          onClick={() => void merge()}
        >
          merge{selected.length > 0 ? ` (${selected.length} selected)` : ''}
        </button>
      </div>
      {authors.loading && <p className="hint">Loading authors…</p>}
      {metrics.loading && <p className="hint">Loading metrics…</p>}
      {authors.error && <p className="error">{authors.error}</p>}
      {metrics.error && <p className="error">{metrics.error}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
