import { execFile, spawn, type ChildProcess } from 'node:child_process';

/** Prevents git from hanging on credential prompts for private URLs. */
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
};

export function runGit(worktree: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', worktree, ...args],
      { env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr ?? '').trim() || err.message;
          reject(new Error(`git ${args.join(' ')} failed: ${detail}`));
        } else {
          resolve(stdout.toString());
        }
      },
    );
  });
}

/**
 * Streams the full commit history of `ref` as NUL-delimited records:
 *
 *   git log <ref> --no-merges -M50% -z --numstat
 *          --format=%x1e%H%x1f%an%x1f%ae%x1f%ct%x1f%s
 *
 * - --no-merges  : H̄ is the set of non-merge commits reachable from the ref.
 * - -M50%        : rename detection with a 50% similarity threshold.
 * - -z           : NUL-delimited, unquoted paths — unambiguous even when a
 *                  path contains " => ", newlines or tabs.
 * - committer date (%ct) drives the H_t / H_i,j commit-set windows.
 */
export function spawnGitLog(worktree: string, ref = 'HEAD'): ChildProcess {
  return spawn(
    'git',
    [
      '-C', worktree,
      'log', ref,
      '--no-merges',
      '-M50%',
      '-z',
      '--numstat',
      '--format=%x1e%H%x1f%an%x1f%ae%x1f%ct%x1f%s',
    ],
    { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

export async function checkGitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], (err) => resolve(!err));
  });
}
