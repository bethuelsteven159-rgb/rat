import type { FileChange } from './logParser';

/**
 * Per-commit directory rollup: every ancestor directory of every touched file
 * accumulates the file's added/removed counts. The root is '/'.
 *
 * This matches the recursive definition in the brief — the directory metric
 * for d is the sum over its immediate files plus its immediate subdirectories,
 * which unrolls to the sum over all descendant files.
 */
export function rollupDirs(
  files: FileChange[],
): Array<{ path: string; added: number; removed: number }> {
  const acc = new Map<string, [number, number]>();
  const add = (dir: string, added: number, removed: number): void => {
    const entry = acc.get(dir);
    if (entry) {
      entry[0] += added;
      entry[1] += removed;
    } else {
      acc.set(dir, [added, removed]);
    }
  };

  for (const file of files) {
    add('/', file.added, file.removed);
    let idx = -1;
    while ((idx = file.path.indexOf('/', idx + 1)) !== -1) {
      add(file.path.slice(0, idx), file.added, file.removed);
    }
  }

  return Array.from(acc, ([path, [added, removed]]) => ({ path, added, removed }));
}
