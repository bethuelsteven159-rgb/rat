export interface MailmapRule {
  /** Replacement name (absent in `<proper> <commit>` form: name is kept). */
  properName?: string;
  properEmail: string;
  /** When set, the rule only matches commits authored with this name. */
  commitName?: string;
  /** When set, the rule matches commits authored with this email. */
  commitEmail?: string;
}

export interface AuthorIdentity {
  name: string;
  email: string;
}

/**
 * One mailmap line, in any of the four documented forms:
 *
 *   Proper Name <proper@email>                              (name for an email)
 *   Proper Name <proper@email> <commit@email>               (any name, commit email)
 *   Proper Name <proper@email> Commit Name <commit@email>   (exact identity)
 *   <proper@email> <commit@email>                           (email only)
 *
 * Blank lines and '#' comments are skipped; malformed lines are tolerated.
 */
const LINE_RE = /^\s*([^<>]*?)\s*<([^<>]+)>\s*(?:([^<>]*?)\s*<([^<>]+)>\s*)?$/;

export function parseMailmap(text: string): MailmapRule[] {
  const rules: MailmapRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;

    const properName = (match[1] ?? '').trim() || undefined;
    const properEmail = (match[2] ?? '').trim();
    const commitName = (match[3] ?? '').trim() || undefined;
    const commitEmail = (match[4] ?? '').trim();

    if (!properEmail) continue;
    if (!commitEmail && !properName) continue; // "<a@x>" alone rewires nothing

    rules.push(
      commitEmail
        ? { properName, properEmail, commitName, commitEmail }
        : { properName: properName!, properEmail },
    );
  }
  return rules;
}

const sameEmail = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** Resolves an identity through the mailmap (first matching rule wins, no chaining). */
export function applyMailmap(name: string, email: string, rules: MailmapRule[]): AuthorIdentity {
  for (const rule of rules) {
    if (rule.commitEmail) {
      if (sameEmail(email, rule.commitEmail) && (!rule.commitName || name === rule.commitName)) {
        return { name: rule.properName ?? name, email: rule.properEmail };
      }
    } else if (rule.properName && sameEmail(email, rule.properEmail)) {
      return { name: rule.properName, email };
    }
  }
  return { name, email };
}
