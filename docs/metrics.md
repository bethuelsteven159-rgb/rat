# Metric semantics

This document defines every metric exactly as the server computes it, together
with the edge cases from the project brief. `src/metrics/queries.ts` is the
normative implementation; this file is the contract.

## Notation

- **H** — the commit set: all **non-merge** commits reachable from the
  repository HEAD (the initial commit's parent is the empty commit, so the
  initial commit *is* included). `--no-merges` in the `git log` invocation
  guarantees this.
- **H_t / H_i,j** — H restricted to committer timestamps: `since` (i) is
  inclusive, `until` (j) is exclusive. Windows always use the **committer**
  date, never the author date.
- **H_a** — H restricted to commits authored by a canonical author.
- **|H|** — the size of the current commit set, returned as
  `commitSetSize` by every metric endpoint.

Filters split into two groups:

| narrows **H** | scopes **measured objects** |
| --- | --- |
| `since`, `until`, `commits`, `authorId` | `path` |

A `path` prefix restricts which files/directories are *measured*; it never
changes |H|, so the denominators below stay meaningful.

## Object metrics (file, directory, repository)

For any object o (a file path, a directory, or the repository root):

| Metric | Definition |
| --- | --- |
| l+ | total lines added on o over the commit set |
| l− | total lines removed on o over the commit set |
| δ (growth) | l+ − l− |
| λ (churn) | l+ + l− |
| n (modifications) | number of commits in which o has churn > 0 |
| η (modification frequency) | n / \|H\| |
| ρ (churn rate) | λ / \|H\| |

- **Repository metrics are directory metrics on the root `/`**; with a
  `path` filter the subtree replaces the root as the measured object.
- **Directory metrics are recursive rollups**: a directory's numbers include
  every file beneath it (and its subdirectories), accumulated per commit from
  the same rename-resolved paths, then summed over the commit set.
- η and ρ are 0 when |H| = 0 (no division by zero).

## Author metrics

| Metric | Definition |
| --- | --- |
| author l+ / l− / δ / λ | object metrics where "the object" is every file the author touched |
| author modifications | number of commits by the author with churn > 0 |
| ω (ownership) | author λ / total λ over the measured objects (0 when total λ = 0) |

## Edge cases

### Renames

Rename detection runs with a **50% similarity threshold** (`-M50%`).
The lines changed during a rename are attributed to the **new path only** —
the old path records nothing for that commit. A **pure rename (0 added,
0 removed) does not count as a modification** of either path. (A renamed
binary file is skipped entirely, like any binary.)

### Merges

Merge commits are excluded from H entirely (`--no-merges`): they contribute
no lines, no modifications and never appear in the commit list. Commits
merged *in* (reachable through the merge) are ordinary members of H.

### Binary files

Not measured — `git log --numstat` reports `-  -` for binary files and the
parser skips them. "Binary" is git's own detection.

### Deletions

Deleting a file records its line count as **removed lines on the deleted
path**. A deleted path therefore keeps its historical metrics.

### The initial commit

Its diff is taken against the empty commit, so every added line counts.

### Author identities

An author is a **canonical author**; each commit carries a raw
`(author name, author email)` identity that resolves to exactly one canonical
author through the alias table. Aliases come from two sources:

1. **`.mailmap`** at the repository HEAD. The four documented forms:
   - `Proper Name <proper@email>`
   - `Proper Name <proper@email> <commit@email>`
   - `Proper Name <proper@email> Commit Name <commit@email>`
   - `<proper@email> <commit@email>`
   The **first matching rule wins**; rules never chain, and email comparison
   is case-insensitive.
2. **Manual merging** via the dashboard (`POST …/authors/merge`): aliases are
   re-pointed to the target canonical author. Merging is metadata-only — no
   metric is recomputed. An identity can be split back out
   (`POST …/authors/unmerge`) unless it is already its own canonical author.

Author metrics are always reported per canonical author, so merging two
identities correctly combines their churn and ownership.

## Timeline

The churn timeline buckets commits by **committer date**:
`day` (`%Y-%m-%d`), `week` (`%Y-%W`) or `month` (`%Y-%m`). Each point carries
the bucket's commit count, l+, l− and δ. Without a path scope every commit of
H appears (with churn 0 for empty commits); with a path scope only commits
touching that subtree appear.
