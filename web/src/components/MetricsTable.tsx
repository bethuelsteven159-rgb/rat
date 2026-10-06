import { useMemo, useState } from 'react';
import { api } from '../api';
import { fmtInt, fmtRatio } from '../format';
import { useAsync } from '../hooks';
import type { CommitFilter, MetricRow } from '../types';

type SortKey =
  | 'path'
  | 'added'
  | 'removed'
  | 'growth'
  | 'churn'
  | 'modifications'
  | 'frequency'
  | 'churnRate';

interface Props {
  repoId: number;
  filter: CommitFilter;
  kind: 'file' | 'dir';
  /** Clicking a path restricts metrics to that subtree. */
  onDrillDown: (path: string) => void;
}

const COLUMNS: Array<{ key: SortKey; label: string; title: string }> = [
  { key: 'path', label: 'path', title: 'path' },
  { key: 'added', label: 'l+', title: 'lines added' },
  { key: 'removed', label: 'l−', title: 'lines removed' },
  { key: 'growth', label: 'δ', title: 'growth = l+ − l−' },
  { key: 'churn', label: 'λ', title: 'churn = l+ + l−' },
  { key: 'modifications', label: 'n', title: 'modifications (commits with churn > 0)' },
  { key: 'frequency', label: 'η', title: 'modification frequency = n / |H|' },
  { key: 'churnRate', label: 'ρ', title: 'churn rate = λ / |H|' },
];

export function MetricsTable({ repoId, filter, kind, onDrillDown }: Props) {
  const { data, error, loading } = useAsync(
    () => (kind === 'file' ? api.fileMetrics(repoId, filter) : api.dirMetrics(repoId, filter)),
    [repoId, filter, kind],
  );
  const [sortKey, setSortKey] = useState<SortKey>('churn');
  const [asc, setAsc] = useState(false);

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    list.sort((a, b) => {
      const av: string | number = a[sortKey];
      const bv: string | number = b[sortKey];
      const cmp =
        typeof av === 'string' || typeof bv === 'string'
          ? String(av).localeCompare(String(bv))
          : av - bv;
      return asc ? cmp : -cmp;
    });
    return list;
  }, [data, sortKey, asc]);

  if (loading) return <p className="hint">Loading…</p>;
  if (error) return <p className="error">{error}</p>;

  const setSort = (key: SortKey) => {
    if (key === sortKey) setAsc(!asc);
    else {
      setSortKey(key);
      setAsc(key === 'path');
    }
  };

  const objectLabel = kind === 'file' ? 'files' : 'directories';

  return (
    <section>
      <table className="metrics-table">
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                title={column.title}
                onClick={() => setSort(column.key)}
                className={sortKey === column.key ? 'sorted' : ''}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row: MetricRow) => (
            <tr key={row.path}>
              <td className="path-cell">
                <button
                  className="link"
                  onClick={() => onDrillDown(row.path)}
                  title="Restrict metrics to this subtree"
                >
                  {row.path}
                </button>
              </td>
              <td className="num">{fmtInt(row.added)}</td>
              <td className="num">{fmtInt(row.removed)}</td>
              <td className="num">{fmtInt(row.growth)}</td>
              <td className="num">{fmtInt(row.churn)}</td>
              <td className="num">{fmtInt(row.modifications)}</td>
              <td className="num">{fmtRatio(row.frequency)}</td>
              <td className="num">{fmtRatio(row.churnRate)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="hint">
                No {objectLabel} match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {data !== null && (
        <p className="hint">
          {rows.length} of {data.rows.length} {objectLabel} · |H| ={' '}
          {data.commitSetSize.toLocaleString()}
        </p>
      )}
    </section>
  );
}
