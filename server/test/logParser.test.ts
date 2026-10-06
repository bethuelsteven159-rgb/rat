import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseGitLog, type CommitRecord } from '../src/git/logParser';

/** Builds a NUL-token stream exactly like `git log -z --numstat --format=...`. */
function streamOf(tokens: string[]): Readable {
  return Readable.from([Buffer.from(tokens.join('\0') + '\0', 'binary')]);
}

function collect(): { commits: CommitRecord[]; onCommit: (c: CommitRecord) => void } {
  const commits: CommitRecord[] = [];
  return { commits, onCommit: (c) => commits.push(c) };
}

const HEADER = (hash: string, name = 'Alice', email = 'a@x', ts = '100'): string =>
  `\x1e${hash}\x1f${name}\x1f${email}\x1f${ts}\x1fsubject ${hash}`;

describe('parseGitLog', () => {
  it('parses plain file changes, stripping the separator newline after headers', async () => {
    const { commits, onCommit } = collect();
    // Real git prefixes only the FIRST numstat token after a header with "\n".
    const result = await parseGitLog(
      streamOf([HEADER('h1'), '\n1\t5\tsrc/main.py', '3\t0\tREADME.md']),
      onCommit,
    );
    expect(result).toEqual({ commits: 1, files: 2 });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.hash).toBe('h1');
    expect(commits[0]!.authorName).toBe('Alice');
    expect(commits[0]!.authorEmail).toBe('a@x');
    expect(commits[0]!.committerTs).toBe(100);
    expect(commits[0]!.subject).toBe('subject h1');
    expect(commits[0]!.files).toEqual([
      { path: 'src/main.py', added: 1, removed: 5 },
      { path: 'README.md', added: 3, removed: 0 },
    ]);
  });

  it('attributes rename changes to the new path (old path first, new second)', async () => {
    const { commits, onCommit } = collect();
    await parseGitLog(streamOf([HEADER('h1'), '\n4\t2\t', 'old/name.c', 'new/name.c']), onCommit);
    expect(commits[0]!.files).toEqual([{ path: 'new/name.c', added: 4, removed: 2 }]);
  });

  it('skips pure renames (0/0) and keeps them out of modifications', async () => {
    const { commits, onCommit } = collect();
    const result = await parseGitLog(
      streamOf([HEADER('h1'), '\n0\t0\t', 'old.txt', 'new.txt', '2\t1\tkept.txt']),
      onCommit,
    );
    expect(result.files).toBe(1);
    expect(commits[0]!.files).toEqual([{ path: 'kept.txt', added: 2, removed: 1 }]);
  });

  it('skips binary files and consumes the path pair of binary renames', async () => {
    const { commits, onCommit } = collect();
    const result = await parseGitLog(
      streamOf([HEADER('h1'), '\n-\t-\tdata.bin', '-\t-\t', 'old.bin', 'new.bin', '1\t1\tok.txt']),
      onCommit,
    );
    expect(result.files).toBe(1);
    expect(commits[0]!.files).toEqual([{ path: 'ok.txt', added: 1, removed: 1 }]);
  });

  it('treats a literal "x => y.txt" path as one file, not a rename', async () => {
    const { commits, onCommit } = collect();
    await parseGitLog(streamOf([HEADER('h1'), '\n1\t0\tx => y.txt']), onCommit);
    expect(commits[0]!.files).toEqual([{ path: 'x => y.txt', added: 1, removed: 0 }]);
  });

  it('keeps raw tabs and newlines inside paths intact', async () => {
    const { commits, onCommit } = collect();
    await parseGitLog(streamOf([HEADER('h1'), '\n1\t0\tta\tb.txt', '2\t0\tnl\nfoo.txt']), onCommit);
    expect(commits[0]!.files).toEqual([
      { path: 'ta\tb.txt', added: 1, removed: 0 },
      { path: 'nl\nfoo.txt', added: 2, removed: 0 },
    ]);
  });

  it('handles empty commits (header directly followed by the next header)', async () => {
    const { commits, onCommit } = collect();
    const result = await parseGitLog(
      streamOf([HEADER('h1'), '\n1\t0\ta.txt', HEADER('h2'), HEADER('h3'), '\n2\t0\tb.txt']),
      onCommit,
    );
    expect(result.commits).toBe(3);
    expect(commits[1]!.files).toEqual([]);
    expect(commits[2]!.files).toEqual([{ path: 'b.txt', added: 2, removed: 0 }]);
  });

  it('skips zero-churn plain entries (mode-only changes, empty files)', async () => {
    const { commits, onCommit } = collect();
    const result = await parseGitLog(streamOf([HEADER('h1'), '\n0\t0\tempty.txt']), onCommit);
    expect(result.files).toBe(0);
    expect(commits[0]!.files).toEqual([]);
  });

  it('throws on a malformed commit header', async () => {
    await expect(
      parseGitLog(streamOf(['\x1enot-a-valid-header']), () => {}),
    ).rejects.toThrow(/Malformed commit record/);
  });

  it('processes tokens split across arbitrary chunk boundaries', async () => {
    const tokens = [HEADER('h1'), '\n1\t2\tsrc/a/b.c', HEADER('h2'), '\n3\t0\tREADME.md'];
    const bytes = Buffer.from(tokens.join('\0') + '\0', 'binary');
    // Split at awkward offsets, including mid-token and mid-UTF8-sequence.
    const stream = Readable.from([
      bytes.subarray(0, 7),
      bytes.subarray(7, 19),
      bytes.subarray(19, bytes.length),
    ]);
    const { commits, onCommit } = collect();
    const result = await parseGitLog(stream, onCommit);
    expect(result).toEqual({ commits: 2, files: 2 });
    expect(commits[0]!.files[0]!.path).toBe('src/a/b.c');
    expect(commits[1]!.files[0]!.path).toBe('README.md');
  });
});
