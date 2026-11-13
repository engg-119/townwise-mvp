import { defaultLocationName, locationEyebrow, shownLocationName } from '../../../src/portal/locations/naming';

// How the portal names a location (spec D29): a new one's default name, the name member pages show, and the
// location header's eyebrow.

const HANOVER = { name: 'Hanover', state: 'NH' };

describe('location naming', () => {
  test('a business defaults to “{Google name}, {Town}”', () => {
    expect(defaultLocationName({ name: 'Sawtooth Kitchen', kind: 'business', town: HANOVER }, 'Sawtooth Group')).toBe('Sawtooth Kitchen, Hanover');
    expect(defaultLocationName({ name: '  Lou’s Bakery ', kind: 'business', town: { name: 'Norwich' } }, 'Lou’s')).toBe('Lou’s Bakery, Norwich');
  });

  test('an address, or a place with no name, takes the organization’s name', () => {
    expect(defaultLocationName({ name: '12 South Main Street', kind: 'address', town: HANOVER }, 'Sawtooth Group')).toBe('Sawtooth Group, Hanover');
    expect(defaultLocationName({ name: null, kind: 'business', town: HANOVER }, 'Sawtooth Group')).toBe('Sawtooth Group, Hanover');
    expect(defaultLocationName({ name: '   ', kind: 'business', town: HANOVER }, 'Sawtooth Group')).toBe('Sawtooth Group, Hanover');
  });

  test('a name that already says its town is not repeated', () => {
    expect(defaultLocationName({ name: 'Hanover Inn', kind: 'business', town: HANOVER }, 'Org')).toBe('Hanover Inn');
    expect(defaultLocationName({ name: 'The HANOVER Diner', kind: 'business', town: HANOVER }, 'Org')).toBe('The HANOVER Diner');
    expect(defaultLocationName({ name: '12 Main', kind: 'address', town: HANOVER }, 'Hanover Hospitality')).toBe('Hanover Hospitality');
    // Only the whole word counts: “Hanoverian” is not Hanover.
    expect(defaultLocationName({ name: 'Hanoverian Pub', kind: 'business', town: HANOVER }, 'Org')).toBe('Hanoverian Pub, Hanover');
  });

  test('a long name is cut so the default keeps its town within 80 characters', () => {
    const long = `Lou’s ${'x'.repeat(94)}`;
    const named = defaultLocationName({ name: long, kind: 'business', town: HANOVER }, 'Org');
    expect(named).toBe(`${long.slice(0, 71)}, Hanover`);
    expect(named).toHaveLength(80);
    // The cut leaves no space before the comma.
    expect(defaultLocationName({ name: `${'a'.repeat(70)} bbbbbbbb`, kind: 'business', town: HANOVER }, 'Org')).toBe(`${'a'.repeat(70)}, Hanover`);
    // A name that holds its town is cut to 80 alone.
    expect(defaultLocationName({ name: `Hanover ${'y'.repeat(90)}`, kind: 'business', town: HANOVER }, 'Org')).toHaveLength(80);
  });

  test('shownLocationName is the organization’s name with one location and the location’s with several', () => {
    const location = { name: 'Sawtooth Kitchen, Hanover' };
    const org = { name: 'Sawtooth Group' };
    expect(shownLocationName(location, { org, locations: [location] })).toBe('Sawtooth Group');
    expect(shownLocationName(location, { org, locations: [location, { name: 'Sawtooth Kitchen, Norwich' }] })).toBe('Sawtooth Kitchen, Hanover');
  });

  test('locationEyebrow: the town alone with one; name and state when the name ends with its town; else name, town and state', () => {
    expect(locationEyebrow({ name: 'Sawtooth Kitchen, Hanover', town: HANOVER }, false)).toBe('Hanover, NH');
    expect(locationEyebrow({ name: 'Sawtooth Kitchen, Hanover', town: HANOVER }, true)).toBe('Sawtooth Kitchen, Hanover, NH');
    expect(locationEyebrow({ name: 'Downtown hanover', town: HANOVER }, true)).toBe('Downtown hanover, NH');
    expect(locationEyebrow({ name: 'Main Street Bar', town: HANOVER }, true)).toBe('Main Street Bar, Hanover, NH');
    // Ends with the town as a whole word only.
    expect(locationEyebrow({ name: 'West Hanover Inn', town: HANOVER }, true)).toBe('West Hanover Inn, Hanover, NH');
    expect(locationEyebrow({ name: 'Bar at New Hanover', town: { name: 'New Hanover', state: 'NC' } }, true)).toBe('Bar at New Hanover, NC');
  });
});
