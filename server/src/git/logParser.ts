import type { Readable } from 'node:stream';

export interface FileChange {
  /** New path of the file (rename-aware: changes are attributed to it). */
  path: string;
  added: number;
  removed: number;
}

export interface CommitRecord {
  hash: string;
  authorName: string;
  authorEmail: string;
  /** Unix committer timestamp — drives the H_t / H_i,j commit-set windows. */
  committerTs: number;
  subject: string;
  files: FileChange[];
}

export interface LogParseResult {
  commits: number;
  files: number;
}

const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t(.*)$/s;

/**
 * Parses the stdout of spawnGitLog() (see git.ts for the exact command).
 *
 * The stream is a sequence of NUL-terminated tokens:
 *
 *   "\x1e<hash>\x1f<name>\x1f<email>\x1f<ts>\x1f<subject>"   — starts a commit
 *   "<added>\t<removed>\t<path>"                              — file change
 *   "<added>\t<removed>\t" followed by "<old>\0<new>"         — rename
 *
 * Rules derived from empirically verified git 2.43 behaviour:
 * - When a commit has diff output, git emits a single "\n" after the header
 *   record; it prefixes the first numstat token and is stripped. Empty
 *   commits have no separator at all.
 * - A rename entry has an empty path field; the next two tokens are the old
 *   path, then the new path. Per the brief, changes are attributed to the
 *   new path and pure renames (0/0) leave metrics untouched.
 * - Binary files ("-" counts) are not measured. A renamed binary still
 *   consumes its two path tokens.
 * - Zero-churn entries (mode-only changes, empty new files) are skipped so
 *   that "modifications" == COUNT(*) of rows stays exact.
 */
export function parseGitLog(
  stdout: Readable,
  onCommit: (commit: CommitRecord) => void,
): Promise<LogParseResult> {
  return new Promise((resolve, reject) => {
    let commitCount = 0;
    let fileCount = 0;
    let current: CommitRecord | null = null;
    let afterHeader = false;
    let renameAdded = 0;
    let renameRemoved = 0;
    let renameOld: string | null = null;
    let inRename = false;
    let failed = false;

    const fail = (err: unknown): void => {
      if (failed) return;
      failed = true;
      reject(err instanceof Error ? err : new Error(String(err)));
      stdout.destroy();
    };

    const handleToken = (raw: Buffer): void => {
      let token = raw.toString('utf8');
      if (afterHeader && token.startsWith('\n')) token = token.slice(1);
      afterHeader = false;

      if (inRename) {
        if (renameOld === null) {
          renameOld = token;
          return;
        }
        // token is the new path — attribute the changes to it
        if (current && (renameAdded > 0 || renameRemoved > 0)) {
          current.files.push({ path: token, added: renameAdded, removed: renameRemoved });
          fileCount++;
        }
        inRename = false;
        renameOld = null;
        return;
      }

      if (token.charCodeAt(0) === 0x1e) {
        if (current) {
          commitCount++;
          onCommit(current);
        }
        const parts = token.slice(1).split('\x1f');
        if (parts.length !== 5 || !/^\d+$/.test(parts[3] ?? '') || !parts[0]) {
          throw new Error(`Malformed commit record: ${JSON.stringify(token.slice(0, 100))}`);
        }
        current = {
          hash: parts[0]!,
          authorName: parts[1]!,
          authorEmail: parts[2]!,
          committerTs: Number(parts[3]),
          subject: parts[4]!,
          files: [],
        };
        afterHeader = true;
        return;
      }

      const match = NUMSTAT_RE.exec(token);
      if (!match || !current) return; // stray token (defensive)

      const addedRaw = match[1]!;
      const removedRaw = match[2]!;
      const path = match[3]!;
      if (addedRaw === '-') {
        // Binary: not measured, but a renamed binary still emits old/new tokens.
        if (path === '') {
          inRename = true;
          renameOld = null;
          renameAdded = -1;
          renameRemoved = -1;
        }
        return;
      }
      const added = Number(addedRaw);
      const removed = Number(removedRaw);
      if (path === '') {
        inRename = true;
        renameOld = null;
        renameAdded = added;
        renameRemoved = removed;
        return;
      }
      if (added === 0 && removed === 0) return; // pure rename or mode-only change
      current.files.push({ path, added, removed });
      fileCount++;
    };

    let carry: Buffer = Buffer.alloc(0);
    const push = (chunk: Buffer): void => {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0;
      let idx = data.indexOf(0);
      while (idx !== -1) {
        handleToken(data.subarray(start, idx));
        start = idx + 1;
        idx = data.indexOf(0, start);
      }
      carry = data.subarray(start);
    };

    stdout.on('data', (chunk: Buffer) => {
      if (failed) return;
      try {
        push(chunk);
      } catch (err) {
        fail(err);
      }
    });
    stdout.on('end', () => {
      if (failed) return;
      try {
        if (carry.length) handleToken(carry);
        if (current) {
          commitCount++;
          onCommit(current);
        }
        resolve({ commits: commitCount, files: fileCount });
      } catch (err) {
        fail(err);
      }
    });
    stdout.on('error', fail);
  });
}
