import type { DB } from '../db/database';
import { applyMailmap, type MailmapRule } from './mailmap';

/**
 * Builds the canonical-author model for a freshly ingested repository:
 *
 *   identity (name, email) --author_aliases--> canonical author
 *
 * Every distinct identity found in commits gets an alias row. Mailmap rules
 * (if any) merge identities by pointing them at a shared canonical author.
 * Manual merges/unmerges later only rewrite these alias rows, so every metric
 * query picks the change up immediately — no recomputation needed.
 */
export function buildAuthorModel(db: DB, repoId: number, rules: MailmapRule[]): void {
  const identities = db
    .prepare('SELECT DISTINCT author_name AS name, author_email AS email FROM commits WHERE repo_id = ?')
    .all(repoId) as Array<{ name: string; email: string }>;

  const findCanonical = db.prepare(
    'SELECT id FROM canonical_authors WHERE repo_id = ? AND name = ? AND email = ?',
  );
  const insertCanonical = db.prepare(
    'INSERT INTO canonical_authors (repo_id, name, email) VALUES (?, ?, ?)',
  );
  const insertAlias = db.prepare(
    'INSERT INTO author_aliases (repo_id, alias_name, alias_email, canonical_id, source) VALUES (?, ?, ?, ?, ?)',
  );

  const tx = db.transaction(() => {
    for (const identity of identities) {
      const target = applyMailmap(identity.name, identity.email, rules);
      let canonicalId = (
        findCanonical.get(repoId, target.name, target.email) as { id: number } | undefined
      )?.id;
      if (canonicalId === undefined) {
        canonicalId = Number(
          insertCanonical.run(repoId, target.name, target.email).lastInsertRowid,
        );
      }
      const merged = target.name !== identity.name || target.email !== identity.email;
      insertAlias.run(repoId, identity.name, identity.email, canonicalId, merged ? 'mailmap' : 'identity');
    }
  });
  tx();
}
