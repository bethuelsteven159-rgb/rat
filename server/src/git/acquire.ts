import AdmZip from 'adm-zip';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GIT_ENV } from './git';

/** Deep-clones `url` into `dest` (no --depth: the brief requires full history). */
export function cloneRepo(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['clone', '--quiet', url, dest],
      { env: GIT_ENV, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          const detail = String(stderr ?? '').trim() || err.message;
          reject(new Error(`git clone failed: ${detail}`));
        } else {
          resolve();
        }
      },
    );
  });
}

/** Rejects absolute paths and any ".." segment (zip-slip protection). */
function isSafeEntryName(name: string): boolean {
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  const segments = name.split('/');
  if (segments[segments.length - 1] === '') segments.pop();
  return segments.every((seg) => seg !== '' && seg !== '..');
}

export function extractZip(zipPath: string, dest: string): void {
  const zip = new AdmZip(zipPath);
  mkdirSync(dest, { recursive: true });
  for (const entry of zip.getEntries()) {
    if (!isSafeEntryName(entry.entryName)) {
      throw new Error(`Unsafe path inside zip: ${entry.entryName}`);
    }
    const target = path.join(dest, entry.entryName);
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.getData());
    }
  }
}

/**
 * Locates the worktree root containing `.git`.
 *
 * - A clone puts `.git/` directly in `root`.
 * - A zip usually wraps the repo in a single top-level directory.
 * - `.git` may also be a *file* ("gitdir: <path>", used by worktrees and
 *   submodules) — its target is resolved relative to the containing directory.
 * Only one level of nesting is scanned, which covers normal repo zips.
 */
export function findWorktree(root: string): string {
  const candidates = [root];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) candidates.push(full);
  }
  for (const dir of candidates) {
    const dotGit = path.join(dir, '.git');
    if (!existsSync(dotGit)) continue;
    const st = statSync(dotGit);
    if (st.isDirectory()) return dir;
    if (st.isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
      if (match && existsSync(path.resolve(dir, match[1]!.trim()))) return dir;
    }
  }
  throw new Error('No .git file or directory found — is this a repository zip?');
}
