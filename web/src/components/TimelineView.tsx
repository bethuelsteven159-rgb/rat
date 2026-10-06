import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { api } from '../api';
import { useAsync } from '../hooks';
import type { CommitFilter, TimelinePoint } from '../types';

interface Props {
  repoId: number;
  filter: CommitFilter;
}

/** Churn timeline, bucketed by committer date. */
export function TimelineView({ repoId, filter }: Props) {
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('month');
  const { data, error, loading } = useAsync(() => api.timeline(repoId, filter, bucket), [
    repoId,
    filter,
    bucket,
  ]);

  return (
    <section>
      <div className="bucket-picker">
        <span className="hint">bucket:</span>
        {(['day', 'week', 'month'] as const).map((b) => (
          <button
            key={b}
            className={bucket === b ? 'tab active' : 'tab'}
            onClick={() => setBucket(b)}
          >
            {b}
          </button>
        ))}
      </div>
      {loading && <p className="hint">Loading…</p>}
      {error && <p className="error">{error}</p>}
      {data !== null && <TimelineChart points={data.points} />}
    </section>
  );
}

function TimelineChart({ points }: { points: TimelinePoint[] }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const hasPoints = points.length > 0;

  useEffect(() => {
    if (!hasPoints || container.current === null) return;
    const instance = echarts.init(container.current);
    chart.current = instance;
    const onResize = () => instance.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      instance.dispose();
      if (chart.current === instance) chart.current = null;
    };
    // Re-init when data appears (or disappears) so the container always
    // exists before echarts touches it.
  }, [hasPoints]);

  useEffect(() => {
    chart.current?.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['added (l+)', 'removed (l−)', 'commits'] },
      grid: { left: 64, right: 24, top: 40, bottom: 40 },
      xAxis: { type: 'category', data: points.map((p) => p.bucket) },
      yAxis: { type: 'value' },
      series: [
        {
          name: 'added (l+)',
          type: 'bar',
          stack: 'churn',
          data: points.map((p) => p.added),
          itemStyle: { color: '#2e9e5b' },
        },
        {
          name: 'removed (l−)',
          type: 'bar',
          stack: 'churn',
          data: points.map((p) => -p.removed),
          itemStyle: { color: '#d64545' },
        },
        {
          name: 'commits',
          type: 'line',
          data: points.map((p) => p.commits),
          itemStyle: { color: '#4a7ec7' },
        },
      ],
    });
  }, [points]);

  if (!hasPoints) {
    return <p className="hint">No activity in the current commit set.</p>;
  }
  return <div ref={container} className="chart" />;
}
