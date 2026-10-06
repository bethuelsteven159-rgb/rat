/** Shared display formatting. */

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtRatio(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function fmtDate(ts: number | null): string {
  return ts === null ? '—' : new Date(ts * 1000).toISOString().slice(0, 10);
}

export function fmtDateTime(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16);
}
