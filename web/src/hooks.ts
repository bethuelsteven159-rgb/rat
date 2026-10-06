import { useEffect, useState } from 'react';

interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Minimal data-fetching hook with stale-response protection: results of an
 * older request never overwrite a newer one after unmount or a dep change.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let alive = true;
    setState((prev) => ({ data: prev.data, error: null, loading: true }));
    fn().then(
      (data) => {
        if (alive) setState({ data, error: null, loading: false });
      },
      (err: unknown) => {
        if (alive) {
          setState({ data: null, error: err instanceof Error ? err.message : String(err), loading: false });
        }
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
