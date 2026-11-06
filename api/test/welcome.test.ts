import { describe, expect, it } from 'vitest';

import { firstNameOf } from '../src/welcome.ts';

describe('firstNameOf', () => {
  it.each([
    ['Sam Rivera', 'Sam'],
    ['Mary Ann Smith', 'Mary'],
    ['  Sam   Rivera ', 'Sam'],
    ['Sam, Rivera', 'Sam'],
    ['Sam', 'Sam'],
    ['Zoë Ng', 'Zoë'],
    ['Al Smith', 'Al'],
  ])('%j is %j', (contactName, expected) => {
    expect(firstNameOf(contactName)).toBe(expected);
  });

  it.each([
    'Dr. Rivera', 'Dr Rivera', 'dr. rivera', 'Mr. Smith', 'Mrs Smith', 'Ms. Smith', 'Mx Smith', 'Prof. Smith',
    'J. Smith', 'J Smith', '', '   ', ',', '.', 'A'.repeat(41),
  ])('%j has no usable first name', (contactName) => {
    expect(firstNameOf(contactName)).toBeNull();
  });

  it('keeps a 40-character token', () => {
    expect(firstNameOf(`${'A'.repeat(40)} Smith`)).toBe('A'.repeat(40));
  });
});
