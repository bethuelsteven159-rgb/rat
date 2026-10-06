import { describe, expect, it } from 'vitest';
import { applyMailmap, parseMailmap } from '../src/authors/mailmap';

describe('parseMailmap', () => {
  it('parses all four documented forms plus comments and blanks', () => {
    const rules = parseMailmap(`
# comment line

Proper Name <proper@email.xx>
Proper Name <proper@email.xx> <commit@email.xx>
Proper Name <proper@email.xx> Commit Name <commit@email.xx>
<proper@email.xx> <commit@email.xx>
`);
    expect(rules).toEqual([
      { properName: 'Proper Name', properEmail: 'proper@email.xx' },
      { properName: 'Proper Name', properEmail: 'proper@email.xx', commitEmail: 'commit@email.xx' },
      {
        properName: 'Proper Name',
        properEmail: 'proper@email.xx',
        commitName: 'Commit Name',
        commitEmail: 'commit@email.xx',
      },
      { properEmail: 'proper@email.xx', commitEmail: 'commit@email.xx' },
    ]);
  });

  it('ignores lines that rewires nothing', () => {
    expect(parseMailmap('<a@x>\n')).toEqual([]);
  });

  it('tolerates malformed lines', () => {
    expect(parseMailmap('garbage without emails\nProper <p@x>')).toEqual([
      { properName: 'Proper', properEmail: 'p@x' },
    ]);
  });
});

describe('applyMailmap', () => {
  it('form 1: rewrites the name of every commit with the proper email', () => {
    const rules = parseMailmap('Alice <alice@x>');
    expect(applyMailmap('alice', 'alice@x', rules)).toEqual({ name: 'Alice', email: 'alice@x' });
    expect(applyMailmap('Bad Name', 'ALICE@X', rules)).toEqual({ name: 'Alice', email: 'ALICE@X' });
    expect(applyMailmap('Bob', 'bob@x', rules)).toEqual({ name: 'Bob', email: 'bob@x' });
  });

  it('form 2: rewrites any identity using the commit email', () => {
    const rules = parseMailmap('Alice <alice@x> <old@x>');
    expect(applyMailmap('Whatever', 'old@x', rules)).toEqual({ name: 'Alice', email: 'alice@x' });
    expect(applyMailmap('Whatever', 'old@X', rules)).toEqual({ name: 'Alice', email: 'alice@x' });
  });

  it('form 3: only matches the exact commit name with the commit email', () => {
    const rules = parseMailmap('Alice <alice@x> Alice Smith <old@x>');
    expect(applyMailmap('Alice Smith', 'old@x', rules)).toEqual({ name: 'Alice', email: 'alice@x' });
    expect(applyMailmap('Someone Else', 'old@x', rules)).toEqual({ name: 'Someone Else', email: 'old@x' });
  });

  it('form 4: rewrites only the email, keeping the name', () => {
    const rules = parseMailmap('<alice@x> <old@x>');
    expect(applyMailmap('Nickname', 'old@x', rules)).toEqual({ name: 'Nickname', email: 'alice@x' });
  });

  it('first matching rule wins and rules do not chain', () => {
    const rules = parseMailmap('A <a@x> <first@x>\nB <b@x> <a@x>');
    expect(applyMailmap('N', 'first@x', rules)).toEqual({ name: 'A', email: 'a@x' });
    // The result of rule 1 (a@x) must not be re-matched by rule 2.
    expect(applyMailmap('N', 'a@x', rules)).toEqual({ name: 'B', email: 'b@x' });
  });
});
