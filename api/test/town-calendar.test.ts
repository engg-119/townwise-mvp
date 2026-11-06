// The public town calendar (src/town-calendar.ts, spec 13.1): federal holidays from their legal rules, key dates and
// the researched entries, every event with a source, the term convention the term state reads, and Hanover's seed
// matching the committed public file row by row.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isCalendarDate } from '../src/dates.ts';
import { TOWN_CALENDAR } from '../src/town-calendar-data.ts';
import { federalHolidays, townCalendarCovers, townEvents, type TownEvent } from '../src/town-calendar.ts';
import { TOWN_IDS } from '../src/towns.ts';

const OPM_URL = 'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/';
const EVERYTHING = { from: '2010-01-01', to: '2030-12-31' };

function dateOf(year: number, slug: string): string | undefined {
  return federalHolidays(year).find((event) => event.group === `us:${slug}`)?.start;
}

function allEvents(): TownEvent[] {
  return [...TOWN_IDS.flatMap((townId) => townEvents(townId, EVERYTHING).filter((event) => event.scope === 'town')), ...townEvents(null, EVERYTHING)];
}

/** RFC 4180 rows: commas inside double quotes stay in the field. */
function csvRows(text: string): string[][] {
  return text.trim().split('\n').map((line) => {
    const fields: string[] = [];
    let field = '';
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { fields.push(field); field = ''; } else field += char;
    }
    fields.push(field);
    return fields;
  });
}

describe('federal holidays', () => {
  it('fall on their legal days', () => {
    expect([2024, 2025, 2026].map((year) => dateOf(year, 'thanksgiving'))).toEqual(['2024-11-28', '2025-11-27', '2026-11-26']);
    expect(dateOf(2026, 'memorial-day')).toBe('2026-05-25');
    expect(dateOf(2026, 'martin-luther-king-jr-day')).toBe('2026-01-19');
    expect(dateOf(2026, 'washingtons-birthday')).toBe('2026-02-16');
    expect(dateOf(2026, 'labor-day')).toBe('2026-09-07');
    expect(dateOf(2026, 'columbus-day')).toBe('2026-10-12');
    expect(dateOf(2025, 'memorial-day')).toBe('2025-05-26');
    expect(dateOf(2021, 'memorial-day')).toBe('2021-05-31');
  });

  it('keep the actual day, not the observed weekday', () => {
    // July 4, 2026 is a Saturday (observed Friday, July 3); Christmas 2022 a Sunday (observed Monday).
    expect(dateOf(2026, 'independence-day')).toBe('2026-07-04');
    expect(dateOf(2022, 'christmas')).toBe('2022-12-25');
  });

  it('add Juneteenth from 2021 only', () => {
    expect(dateOf(2020, 'juneteenth')).toBeUndefined();
    expect(dateOf(2021, 'juneteenth')).toBe('2021-06-19');
    expect(federalHolidays(2020)).toHaveLength(10);
    expect(federalHolidays(2026)).toHaveLength(11);
  });

  it('carry the OPM source, stable ids and a group per holiday', () => {
    const thanksgiving = federalHolidays(2026).find((event) => event.group === 'us:thanksgiving');
    expect(thanksgiving).toEqual({
      id: 'us:thanksgiving:2026', title: 'Thanksgiving Day', start: '2026-11-26', end: '2026-11-26', kind: 'holiday',
      scope: 'national', group: 'us:thanksgiving', groupLabel: 'Thanksgiving', confidence: null,
      sources: [{ label: 'U.S. Office of Personnel Management', url: OPM_URL }],
    });
    for (const event of federalHolidays(2026)) expect(event.sources).toEqual([{ label: 'U.S. Office of Personnel Management', url: OPM_URL }]);
  });
});

describe('townEvents', () => {
  it('give every event at least one https source with a label, real dates and start <= end', () => {
    for (const event of allEvents()) {
      expect(event.sources.length, event.id).toBeGreaterThan(0);
      for (const source of event.sources) {
        expect(source.url, event.id).toMatch(/^https:\/\/\S+$/);
        expect(source.label.length, event.id).toBeGreaterThan(0);
      }
      expect(isCalendarDate(event.start) && isCalendarDate(event.end), event.id).toBe(true);
      expect(event.start <= event.end, event.id).toBe(true);
    }
  });

  it('give unique, stable ids', () => {
    const ids = allEvents().map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'us:thanksgiving:2026', 'hanover-nh:2026-11-17:fall-term-classes-end', 'hanover-nh:2025-09-15:fall-term-classes',
      'hanover-nh:2026-11-20:fall-term-finals', 'hanover-nh:2026-10-03:home-football-vs-penn',
    ]));
  });

  it('keep multi-day events that overlap the range, and sort by start, then id', () => {
    const events = townEvents('hanover-nh', { from: '2025-11-01', to: '2025-11-30' });
    expect(events.map((event) => event.id)).toEqual([
      'hanover-nh:2025-09-15:fall-term-classes',
      'hanover-nh:2025-11-08:home-football-vs-princeton',
      'us:veterans-day:2025',
      'hanover-nh:2025-11-15:home-football-vs-cornell',
      'hanover-nh:2025-11-21:fall-term-finals',
      'us:thanksgiving:2025',
    ]);
    expect(townEvents('hanover-nh', { from: '2025-11-26', to: '2025-11-26' }).map((event) => event.id))
      .toEqual(['hanover-nh:2025-11-21:fall-term-finals']);
  });

  it('give holidays for every year a range touches', () => {
    expect(townEvents(null, { from: '2026-12-20', to: '2027-01-02' }).map((event) => event.id))
      .toEqual(['us:christmas:2026', 'us:new-years-day:2027']);
  });

  it('give a town outside the twelve, and a listed town with nothing researched, holidays only', () => {
    for (const townId of [null, 'nantucket-ma']) {
      const events = townEvents(townId, { from: '2026-01-01', to: '2026-12-31' });
      expect(events).toHaveLength(11);
      expect(events.every((event) => event.kind === 'holiday')).toBe(true);
    }
  });

  it('map key dates to single-day town events with their sources, no group and no confidence', () => {
    const [classesEnd] = townEvents('hanover-nh', { from: '2026-11-17', to: '2026-11-17' }).filter((event) => event.kind === 'event');
    expect(classesEnd).toEqual({
      id: 'hanover-nh:2026-11-17:fall-term-classes-end', title: 'Fall term classes end', start: '2026-11-17', end: '2026-11-17',
      kind: 'event', scope: 'town', group: null, groupLabel: null, confidence: null,
      sources: [{
        label: 'registrar.dartmouth.edu',
        url: 'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates',
      }],
    });
  });

  it('use no em dash in any title or label', () => {
    for (const event of allEvents()) {
      expect([event.title, event.groupLabel ?? '', ...event.sources.map((source) => source.label)].join(' ')).not.toContain('\u2014');
    }
  });
});

describe('townCalendarCovers', () => {
  it('is null for a town with nothing researched and for a town outside the twelve', () => {
    expect(townCalendarCovers('nantucket-ma')).toBeNull();
    expect(townCalendarCovers(null)).toBeNull();
  });

  it('spans the town’s researched events over all years', () => {
    // Hanover: winter 2025 classes (the seed) to the winter 2027 key date.
    expect(townCalendarCovers('hanover-nh')).toEqual({ from: '2025-01-06', to: '2027-01-05' });
    // Amherst: its three key dates only.
    const amherst = townEvents('amherst-ma', EVERYTHING).filter((event) => event.scope === 'town');
    expect(townCalendarCovers('amherst-ma')).toEqual({ from: amherst[0]?.start, to: amherst.at(-1)?.end });
  });
});

describe('the researched calendar data', () => {
  it('names one of the twelve towns, a rated confidence and at least one source per entry', () => {
    for (const entry of TOWN_CALENDAR) {
      expect(TOWN_IDS).toContain(entry.townId);
      expect(['high', 'medium', 'low']).toContain(entry.confidence);
      expect(entry.sources.length).toBeGreaterThan(0);
    }
  });

  it('follows the term convention: kind term exactly when the group is {townId}:classes or finals:{season}', () => {
    const termGroup = /^([a-z-]+):(classes|finals):(fall|winter|spring|summer)$/;
    for (const entry of TOWN_CALENDAR) {
      const match = termGroup.exec(entry.group);
      expect({ group: entry.group, term: match !== null }).toEqual({ group: entry.group, term: entry.kind === 'term' });
      if (match !== null) expect(match[1]).toBe(entry.townId);
    }
  });

  it('puts each town’s terms in order: classes, then that season’s finals, never overlapping', () => {
    for (const townId of TOWN_IDS) {
      const terms = TOWN_CALENDAR.filter((entry) => entry.townId === townId && entry.kind === 'term')
        .toSorted((a, b) => (a.start < b.start ? -1 : 1));
      terms.forEach((entry, index) => {
        const [, part, season] = entry.group.split(':');
        expect(part).toBe(index % 2 === 0 ? 'classes' : 'finals');
        const previous = terms[index - 1];
        if (previous !== undefined) {
          expect(previous.end < entry.start, entry.group).toBe(true);
          if (part === 'finals') expect(previous.group).toBe(`${townId}:classes:${season ?? ''}`);
        }
      });
    }
  });

  it('seeds Hanover from modeling/dartmouth_calendar_2025_2026.csv, one entry per row, dates, source and confidence exact', () => {
    const csv = readFileSync(new URL('../../modeling/dartmouth_calendar_2025_2026.csv', import.meta.url), 'utf8');
    const [header, ...rows] = csvRows(csv);
    expect(header).toEqual(['event', 'kind', 'start_date', 'end_date', 'source_url', 'confidence', 'notes']);
    const kindOf: Record<string, string> = { term_classes: 'term', finals: 'term' };
    const groupOf: Record<string, string> = {
      commencement: 'commencement', green_key: 'green-key', homecoming: 'homecoming', winter_carnival: 'winter-carnival',
      family_weekend: 'family-weekend', orientation: 'orientation', football_home: 'home-football',
    };
    const expected = rows.map(([event = '', kind = '', start, end, url, confidence]) => {
      const season = event.split(' ')[0]?.toLowerCase() ?? '';
      const group = kind === 'term_classes' ? `classes:${season}` : kind === 'finals' ? `finals:${season}` : groupOf[kind];
      return { start, end, kind: kindOf[kind] ?? 'event', group: `hanover-nh:${group ?? kind}`, url, confidence };
    });
    const seeded = TOWN_CALENDAR.filter((entry) => entry.townId === 'hanover-nh').map((entry) => ({
      start: entry.start, end: entry.end, kind: entry.kind, group: entry.group, url: entry.sources[0]?.url, confidence: entry.confidence,
    }));
    expect(rows).toHaveLength(38);
    expect(seeded).toEqual(expected);
  });
});
