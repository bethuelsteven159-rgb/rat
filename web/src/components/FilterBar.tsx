import type { AuthorView, CommitFilter } from '../types';

interface Props {
  authors: AuthorView[];
  filter: CommitFilter;
  onChange: (patch: Partial<CommitFilter>) => void;
  commitSetSize: number | null;
}

const DAY = 86_400;

function toTs(date: string, endOfDay = false): number | undefined {
  if (date === '') return undefined;
  const ts = Date.parse(`${date}T00:00:00Z`) / 1000;
  return Number.isNaN(ts) ? undefined : endOfDay ? ts + DAY : ts;
}

function toDate(ts: number | undefined): string {
  return ts === undefined ? '' : new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Commit-set filters. `since`/`until` operate on committer dates: since is
 * inclusive, until is exclusive (a picked "until" day is fully included).
 */
export function FilterBar({ authors, filter, onChange, commitSetSize }: Props) {
  return (
    <div className="filter-bar">
      <label>
        <span>since</span>
        <input
          type="date"
          value={toDate(filter.since)}
          onChange={(e) => onChange({ since: toTs(e.target.value) })}
        />
      </label>
      <label>
        <span>until</span>
        <input
          type="date"
          value={toDate(filter.until === undefined ? undefined : filter.until - DAY)}
          onChange={(e) => onChange({ until: toTs(e.target.value, true) })}
        />
      </label>
      <label>
        <span>author</span>
        <select
          value={filter.authorId ?? ''}
          onChange={(e) =>
            onChange({ authorId: e.target.value === '' ? undefined : Number(e.target.value) })
          }
        >
          <option value="">all</option>
          {authors.map((author) => (
            <option key={author.id} value={author.id}>
              {author.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>path</span>
        <input
          className="path-input"
          placeholder="e.g. src"
          value={filter.path ?? ''}
          onChange={(e) => onChange({ path: e.target.value === '' ? undefined : e.target.value })}
        />
      </label>
      <span className="commit-count" title="Size of the filtered commit set H">
        |H| = {commitSetSize === null ? '…' : commitSetSize.toLocaleString()}
        {filter.commits !== undefined &&
          filter.commits.length > 0 &&
          ` · ${filter.commits.length} selected`}
      </span>
      <button
        className="ghost"
        onClick={() =>
          onChange({
            since: undefined,
            until: undefined,
            authorId: undefined,
            path: undefined,
            commits: undefined,
          })
        }
      >
        reset filters
      </button>
    </div>
  );
}
