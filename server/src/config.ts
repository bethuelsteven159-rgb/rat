import path from 'node:path';

function resolveFromRoot(p: string | undefined, fallback: string): string {
  if (!p) return fallback;
  return path.isAbsolute(p) ? p : path.resolve(p);
}

const cwd = process.cwd();

export const config = {
  /** API server port. The web dev server proxies /api here. */
  port: Number(process.env.RAT_PORT ?? 4000),
  /** Root directory for the SQLite database and cloned/uploaded repositories. */
  dataDir: resolveFromRoot(process.env.RAT_DATA_DIR, path.join(cwd, 'data')),
};

export function dbFile(): string {
  return path.join(config.dataDir, 'rat.db');
}

export function reposDir(): string {
  return path.join(config.dataDir, 'repos');
}
