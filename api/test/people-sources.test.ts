// The researched headcount inputs (api/src/people-in-town/sources.ts, spec 13.2): every source id resolves, every
// URL is https, values are positive whole numbers, the margin is below its value, student housing fits in the town,
// months are YYYY-MM, and no town appears twice. Committed empty (owner decision 3); the rules also run on a
// synthetic entry so they are known to bite.
import { describe, expect, it } from 'vitest';

import { PEOPLE_DATA, PEOPLE_SOURCES, TOWN_PEOPLE, type PeopleData } from '../src/people-in-town/sources.ts';
import { TOWN_IDS } from '../src/towns.ts';

function problems(data: PeopleData): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const source of data.sources) {
    if (!/^[a-z0-9-]{1,40}$/.test(source.id) || source.id === 'bls-qcew' || /^cal-\d+$/.test(source.id)) out.push(`bad id ${source.id}`);
    if (ids.has(source.id)) out.push(`duplicate source ${source.id}`);
    ids.add(source.id);
    if (URL.parse(source.url)?.protocol !== 'https:') out.push(`not https ${source.id}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(source.retrieved)) out.push(`bad retrieved ${source.id}`);
  }
  const whole = (value: number): boolean => Number.isInteger(value) && value > 0;
  const towns = new Set<string>();
  for (const town of data.towns) {
    if (!(TOWN_IDS as readonly string[]).includes(town.townId)) out.push(`unknown town ${town.townId}`);
    if (towns.has(town.townId)) out.push(`duplicate town ${town.townId}`);
    towns.add(town.townId);
    const cited = [
      town.residents?.sourceId, town.studentHousing?.sourceId, town.enrollment?.sourceId, town.housingClosesBetweenTerms?.sourceId,
      town.visitors?.sourceId, ...town.eventAttendance.map((row) => row.sourceId),
    ].filter((id): id is string => id !== undefined);
    for (const id of cited) if (!ids.has(id)) out.push(`unresolved ${id}`);
    const values = [
      town.residents?.value, town.studentHousing?.value, town.enrollment?.value,
      ...town.eventAttendance.map((row) => row.high), ...(town.visitors?.monthly.map((row) => row.value) ?? []),
    ].filter((value): value is number => value !== undefined);
    for (const value of values) if (!whole(value)) out.push(`not a positive whole number ${String(value)}`);
    const { residents, studentHousing } = town;
    if (residents?.moe90 != null && !(Number.isInteger(residents.moe90) && residents.moe90 >= 0 && residents.moe90 < residents.value)) {
      out.push(`bad margin ${town.townId}`);
    }
    if (studentHousing !== null && residents !== null && studentHousing.value > residents.value) out.push(`housing above residents ${town.townId}`);
    for (const row of town.visitors?.monthly ?? []) if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)) out.push(`bad month ${row.month}`);
  }
  return out;
}

describe('the committed headcount inputs', () => {
  it('are empty until a teammate researches them, and pass the rules', () => {
    expect(PEOPLE_SOURCES).toEqual([]);
    expect(TOWN_PEOPLE).toEqual([]);
    expect(problems(PEOPLE_DATA)).toEqual([]);
  });
});

describe('the rules', () => {
  const good: PeopleData = {
    sources: [{ id: 'census-test', label: 'Synthetic census table', url: 'https://census.example.test/p1', retrieved: '2026-11-01', confidence: 'high' }],
    towns: [{
      townId: 'hanover-nh',
      residents: { value: 10_000, moe90: 500, vintage: '2020', sourceId: 'census-test' },
      studentHousing: { value: 3000, vintage: '2020', sourceId: 'census-test' },
      enrollment: null,
      housingClosesBetweenTerms: null,
      eventAttendance: [],
      visitors: { label: 'Synthetic visits', monthly: [{ month: '2026-06', value: 3000 }], sourceId: 'census-test' },
    }],
  };

  it('pass a well-formed synthetic entry', () => {
    expect(problems(good)).toEqual([]);
  });

  it('catch an unresolved id, a plain-http URL, a margin at its value, housing above residents, a bad month and a repeated town', () => {
    const [town] = good.towns;
    const [source] = good.sources;
    if (town === undefined || source === undefined) throw new Error('fixture');
    const bad: PeopleData = {
      sources: [{ ...source, url: 'http://census.example.test/p1' }],
      towns: [
        {
          ...town,
          residents: { value: 1000, moe90: 1000, vintage: '2020', sourceId: 'census-test' },
          studentHousing: { value: 2000, vintage: '2020', sourceId: 'missing-id' },
          visitors: { label: 'Synthetic visits', monthly: [{ month: '2026-13', value: 1.5 }], sourceId: 'census-test' },
        },
        town,
      ],
    };
    expect(problems(bad)).toEqual([
      'not https census-test', 'unresolved missing-id', 'not a positive whole number 1.5', 'bad margin hanover-nh',
      'housing above residents hanover-nh', 'bad month 2026-13', 'duplicate town hanover-nh',
    ]);
  });
});
