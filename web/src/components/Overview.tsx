import { api } from '../api';
import { fmtDate, fmtInt, fmtRatio } from '../format';
import { useAsync } from '../hooks';
import type { CommitFilter } from '../types';

interface Props {
  repoId: number;
  filter: CommitFilter;
}

/** Repository-level metrics: directory metrics on the root ("/"). */
export function Overview({ repoId, filter }: Props) {
  const { data, error, loading } = useAsync(() => api.repositoryMetrics(repoId, filter), [
    repoId,
    filter,
  ]);

  if (loading) return <p className="hint">Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  if (data === null) return null;

  const frequency = data.commitSetSize > 0 ? data.modifications / data.commitSetSize : 0;
  const churnRate = data.commitSetSize > 0 ? data.churn / data.commitSetSize : 0;

  const cards = [
    { label: '|H| commits', value: fmtInt(data.commitSetSize), hint: 'non-merge commits in scope' },
    { label: 'authors', value: fmtInt(data.authorCount), hint: 'canonical authors' },
    { label: 'l+ added', value: fmtInt(data.added), hint: 'lines added' },
    { label: 'l− removed', value: fmtInt(data.removed), hint: 'lines removed' },
    { label: 'δ growth', value: fmtInt(data.growth), hint: 'growth = l+ − l−' },
    { label: 'λ churn', value: fmtInt(data.churn), hint: 'churn = l+ + l−' },
    { label: 'n modifications', value: fmtInt(data.modifications), hint: 'commits with churn > 0' },
    { label: 'η frequency', value: fmtRatio(frequency), hint: 'modification frequency = n / |H|' },
    { label: 'ρ churn rate', value: fmtRatio(churnRate), hint: 'churn rate = λ / |H|' },
  ];

  return (
    <section>
      <div className="cards">
        {cards.map((card) => (
          <div className="card" key={card.label} title={card.hint}>
            <span className="card-value">{card.value}</span>
            <span className="card-label">{card.label}</span>
          </div>
        ))}
      </div>
      <p className="hint">
        first commit {fmtDate(data.firstTs)} · last commit {fmtDate(data.lastTs)}
      </p>
    </section>
  );
}
