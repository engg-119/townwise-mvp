// The researched, dated town calendar (spec 13.1). town-calendar.ts merges these entries with each town's key dates
// (town-profiles.ts) and the computed US federal holidays. Hand-curated: every entry carries at least one source and
// the confidence its research gave it, and test/town-calendar.test.ts pins both.
//
// Hanover is seeded from the committed public file modeling/dartmouth_calendar_2025_2026.csv, one entry per row, with
// the row's dates, source URL and confidence copied exactly (the test reads the file and compares). Where the file's
// notes column changes how a date reads, a comment says so. No other town has entries yet.
//
// Term entries follow one convention, which the term state (spec 13.2) reads:
//   kind 'term'; group '{townId}:classes:{season}' for the class period or '{townId}:finals:{season}' for the exam
//   period; season one of fall, winter, spring, summer.
//
// Headcount inputs (residents, students in college housing, enrollment, whether dorms close between terms) are not
// part of this calendar. They are not researched yet for any town and stay empty, labelled as such, in the people
// in town sources (spec 13.2), until a teammate researches them with a source for each number.
import type { TownId } from './towns.ts';

export interface CalendarSource { readonly label: string; readonly url: string }

export interface TownCalendarEntry {
  readonly townId: TownId;
  readonly title: string;
  /** Inclusive ISO days; a single day has end equal to start. */
  readonly start: string;
  readonly end: string;
  readonly kind: 'event' | 'term' | 'season';
  /** A recurring kind, for drivers; terms follow the convention above. */
  readonly group: string;
  readonly groupLabel: string;
  /** As the research rated it: 'high' for the registrar or a current official calendar, 'medium' otherwise. */
  readonly confidence: 'high' | 'medium' | 'low';
  readonly sources: readonly CalendarSource[];
}

const REGISTRAR_2025_26: CalendarSource = {
  label: 'Dartmouth Registrar, 2025-26 key dates',
  url: 'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2025-2026-key-dates',
};
const REGISTRAR_2026_27: CalendarSource = {
  label: 'Dartmouth Registrar, 2026-27 key dates',
  url: 'https://registrar.dartmouth.edu/calendars/academic-institutional-calendars/2026-2027-key-dates',
};
const FIVE_YEAR_JUL_2024: CalendarSource = {
  label: 'Dartmouth Conferences and Events five-year calendar, July 2024 (Internet Archive copy)',
  url: 'https://web.archive.org/web/2/https://dartmouth.edu/cse/docs/5_year_calendar_07082024.pdf',
};
const FIVE_YEAR_MAR_2025: CalendarSource = {
  label: 'Dartmouth Conferences and Events five-year calendar, March 2025 (Internet Archive copy)',
  url: 'https://web.archive.org/web/2/https://dartmouth.edu/cse/docs/5_year_calendar_03212025.pdf',
};
const FIVE_YEAR_SEP_2025: CalendarSource = {
  label: 'Dartmouth Conferences and Events five-year calendar, September 2025 (Internet Archive copy)',
  url: 'https://web.archive.org/web/2/https://www.dartmouth.edu/cse/docs/5_year_calendar_09162025.pdf',
};
const FIVE_YEAR_MAY_2026: CalendarSource = {
  label: 'Dartmouth Conferences and Events five-year calendar, May 2026 (Internet Archive copy)',
  url: 'https://web.archive.org/web/2/https://www.dartmouth.edu/cse/docs/5_year_calendar_05292026.pdf',
};
const FIVE_YEAR_OCT_2026: CalendarSource = {
  label: 'Dartmouth Conferences and Events five-year calendar, October 2026',
  url: 'https://www.dartmouth.edu/cse/docs/5_year_calendar_10162026.pdf',
};
const FOOTBALL_2025_WIKIPEDIA: CalendarSource = {
  label: 'Wikipedia, 2025 Dartmouth Big Green football team',
  url: 'https://en.wikipedia.org/wiki/2025_Dartmouth_Big_Green_football_team',
};
const FOOTBALL_2025_PROMOTIONS: CalendarSource = {
  label: 'Dartmouth Athletics, 2025 football promotional schedule',
  url: 'https://dartmouthsports.com/news/2025/8/26/football-announces-2025-promotional-schedule',
};
const FOOTBALL_2026_FBSCHEDULES: CalendarSource = {
  label: 'FBSchedules, Dartmouth 2026 football schedule',
  url: 'https://fbschedules.com/dartmouth-adds-merrimack-completes-2026-football-schedule/',
};
const HOMECOMING_2025_NEWS: CalendarSource = {
  label: 'Dartmouth News, Homecoming 2025 preview',
  url: 'https://home.dartmouth.edu/news/2025/10/get-ready-homecoming-2025',
};

type Season = 'fall' | 'winter' | 'spring' | 'summer';
type Rated = Pick<TownCalendarEntry, 'confidence' | 'sources'>;

const SEASON_NAME: Record<Season, string> = { fall: 'Fall', winter: 'Winter', spring: 'Spring', summer: 'Summer' };

function classes(season: Season, start: string, end: string, rated: Rated): TownCalendarEntry {
  const title = `${SEASON_NAME[season]} term classes`;
  return { townId: 'hanover-nh', title, start, end, kind: 'term', group: `hanover-nh:classes:${season}`, groupLabel: title, ...rated };
}

function finals(season: Season, start: string, end: string, rated: Rated): TownCalendarEntry {
  const title = `${SEASON_NAME[season]} term finals`;
  return { townId: 'hanover-nh', title, start, end, kind: 'term', group: `hanover-nh:finals:${season}`, groupLabel: title, ...rated };
}

function event(title: string, group: string, groupLabel: string, start: string, end: string, rated: Rated): TownCalendarEntry {
  return { townId: 'hanover-nh', title, start, end, kind: 'event', group: `hanover-nh:${group}`, groupLabel, ...rated };
}

function homeFootball(opponent: string, day: string, rated: Rated): TownCalendarEntry {
  return event(`Home football vs ${opponent}`, 'home-football', 'Home football', day, day, rated);
}

const high = (...sources: CalendarSource[]): Rated => ({ confidence: 'high', sources });
const medium = (...sources: CalendarSource[]): Rated => ({ confidence: 'medium', sources });

export const TOWN_CALENDAR: readonly TownCalendarEntry[] = [
  // Terms. The 2024-25 registrar page was gone when researched, so winter and spring 2025 come from the
  // Conferences and Events calendar.
  classes('winter', '2025-01-06', '2025-03-07', medium(FIVE_YEAR_JUL_2024)),
  finals('winter', '2025-03-10', '2025-03-14', medium(FIVE_YEAR_JUL_2024)),
  // Spring 2025's start is from the July 2024 version, its end and exams from the March 2025 version.
  classes('spring', '2025-03-31', '2025-06-04', high(FIVE_YEAR_MAR_2025)),
  finals('spring', '2025-06-06', '2025-06-10', high(FIVE_YEAR_MAR_2025)),
  classes('summer', '2025-06-26', '2025-08-27', high(REGISTRAR_2025_26)),
  // No exams on Labor Day, 2025-09-01.
  finals('summer', '2025-08-30', '2025-09-02', high(REGISTRAR_2025_26)),
  classes('fall', '2025-09-15', '2025-11-18', high(REGISTRAR_2025_26)),
  // Exams suspended on 2025-11-22; scheduled exams end 2025-11-25.
  finals('fall', '2025-11-21', '2025-11-26', high(REGISTRAR_2025_26)),
  classes('winter', '2026-01-05', '2026-03-10', high(REGISTRAR_2025_26)),
  finals('winter', '2026-03-13', '2026-03-17', high(REGISTRAR_2025_26)),
  classes('spring', '2026-03-30', '2026-06-03', high(REGISTRAR_2025_26)),
  finals('spring', '2026-06-05', '2026-06-09', high(REGISTRAR_2025_26)),
  classes('summer', '2026-06-25', '2026-08-26', high(REGISTRAR_2026_27)),
  finals('summer', '2026-08-29', '2026-09-01', high(REGISTRAR_2026_27)),
  classes('fall', '2026-09-14', '2026-11-17', high(REGISTRAR_2026_27)),
  finals('fall', '2026-11-20', '2026-11-25', high(REGISTRAR_2026_27)),

  // Commencement; Class Day and Baccalaureate are the day before.
  event('Commencement', 'commencement', 'Commencement', '2025-06-15', '2025-06-15', high(FIVE_YEAR_MAR_2025)),
  event('Commencement', 'commencement', 'Commencement', '2026-06-14', '2026-06-14', high(REGISTRAR_2025_26)),
  // Friday and Saturday per the calendar; weekend events may run into Sunday (the Collis page said May 15 to 17, 2026).
  event('Green Key weekend', 'green-key', 'Green Key', '2025-05-16', '2025-05-17', medium(FIVE_YEAR_MAR_2025)),
  event('Green Key weekend', 'green-key', 'Green Key', '2026-05-15', '2026-05-16', medium(FIVE_YEAR_MAY_2026)),
  // 2025: football vs Yale on Saturday 10-11; the Dartmouth News page says October 10 and 11.
  event('Dartmouth Night and Homecoming', 'homecoming', 'Homecoming', '2025-10-10', '2025-10-12', high(FIVE_YEAR_SEP_2025, HOMECOMING_2025_NEWS)),
  // 2026: Dartmouth Night Friday 10-02, football vs Penn Saturday 10-03.
  event('Dartmouth Night and Homecoming', 'homecoming', 'Homecoming', '2026-10-02', '2026-10-03', high(FIVE_YEAR_OCT_2026)),
  event('Winter Carnival', 'winter-carnival', 'Winter Carnival', '2025-02-06', '2025-02-09', medium(FIVE_YEAR_JUL_2024)),
  event('Winter Carnival', 'winter-carnival', 'Winter Carnival', '2026-02-05', '2026-02-08', medium(FIVE_YEAR_SEP_2025)),
  event('Family Weekend', 'family-weekend', 'Family Weekend', '2025-09-26', '2025-09-28', high(FIVE_YEAR_SEP_2025)),
  event('Family Weekend', 'family-weekend', 'Family Weekend', '2026-09-25', '2026-09-27', medium(FIVE_YEAR_MAY_2026)),
  // Pre-orientation and orientation; the exact move-in day was not found.
  event('New student orientation', 'orientation', 'Orientation', '2025-09-03', '2025-09-15', medium(FIVE_YEAR_SEP_2025)),
  event('New student orientation', 'orientation', 'Orientation', '2026-09-02', '2026-09-14', medium(FIVE_YEAR_MAY_2026)),

  // Home football at Memorial Field.
  homeFootball('New Hampshire', '2025-09-20', medium(FOOTBALL_2025_WIKIPEDIA)),
  homeFootball('Yale', '2025-10-11', high(FOOTBALL_2025_PROMOTIONS)),
  // A Friday night game; the five-year calendar's Saturday 10-25 is wrong.
  homeFootball('Columbia', '2025-10-24', medium(FOOTBALL_2025_WIKIPEDIA)),
  homeFootball('Princeton', '2025-11-08', medium(FOOTBALL_2025_WIKIPEDIA)),
  homeFootball('Cornell', '2025-11-15', medium(FOOTBALL_2025_WIKIPEDIA)),
  homeFootball('Monmouth', '2026-09-26', medium(FOOTBALL_2026_FBSCHEDULES)),
  homeFootball('Penn', '2026-10-03', high(FIVE_YEAR_OCT_2026)),
  homeFootball('Merrimack', '2026-10-17', high(FIVE_YEAR_OCT_2026)),
  // A Friday night game; an earlier schedule listed Saturday 10-31.
  homeFootball('Harvard', '2026-10-30', medium(FIVE_YEAR_OCT_2026)),
  // Kickoff time not yet published.
  homeFootball('Brown', '2026-11-21', medium(FOOTBALL_2026_FBSCHEDULES)),

  // Researched after the seed file (2026-11-06), so Hanover's term state stays known past fall 2026 finals. The
  // modeling team's CSV stops at fall 2026 and feeds demand_model_v0.ipynb, so these rows live only here, and
  // api/test/town-calendar.test.ts pins them apart from the CSV's rows.
  classes('winter', '2027-01-05', '2027-03-09', high(REGISTRAR_2026_27)),
  // Scheduled exams end 2027-03-15; the exam period ends 2027-03-16.
  finals('winter', '2027-03-12', '2027-03-16', high(REGISTRAR_2026_27)),
  classes('spring', '2027-03-29', '2027-06-02', high(REGISTRAR_2026_27)),
  // Scheduled exams end 2027-06-07; the exam period ends 2027-06-08.
  finals('spring', '2027-06-04', '2027-06-08', high(REGISTRAR_2026_27)),
  event('Commencement', 'commencement', 'Commencement', '2027-06-13', '2027-06-13', high(REGISTRAR_2026_27)),
];
