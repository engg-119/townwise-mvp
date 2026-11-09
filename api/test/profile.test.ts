import { describe, expect, it } from 'vitest';

import { displayNameOf } from '../src/handlers/profile.ts';

describe('displayNameOf', () => {
  it('refuses digits, emoji, 41 characters and blanks; accepts Hebrew and O’Brien', () => {
    for (const bad of ['Cam2', 'Cam 🍕', 'a'.repeat(41), '   ', '', '<b>', 'Cam\u0000', '-Cam', 'Cam-']) expect(displayNameOf(bad)).toBeNull();
    expect(displayNameOf('  Mary   Jo ')).toBe('Mary Jo');
    expect(displayNameOf('O’Brien')).toBe('O’Brien');
    expect(displayNameOf('O\'Brien')).toBe('O\'Brien');
    expect(displayNameOf('שרה')).toBe('שרה');
    expect(displayNameOf('Jean-Luc')).toBe('Jean-Luc');
    expect(displayNameOf('St.')).toBe('St.');
    expect(displayNameOf('a'.repeat(40))).toBe('a'.repeat(40));
  });

  it('normalizes to NFC, so a decomposed accent counts as one character', () => {
    expect(displayNameOf('José')).toBe('José');
  });
});
