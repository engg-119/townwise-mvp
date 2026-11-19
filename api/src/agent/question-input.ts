// What TownwiseAI's questions are computed from (agent/questions.ts questionsFor), read from the location's own records:
// its coverage, the days of the window and the 56 before it (D32), its notes, done answers, rule schedules, turned-off
// days (D28) and (D59 slice 5) the days its calendars plainly say it was closed (calendar/closed-events.ts). One reader
// for the side panel (handlers/agent.ts) and for a calendar's answers (calendar/answers.ts). Reads only.
import type { OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { closedDaysOf, closedEventsOf } from '../calendar/closed-events.ts';
import { TYPICAL_LOOKBACK_DAYS } from '../closed-days.ts';
import { utcDay } from '../dates.ts';
import type { AnswerRecord } from '../stores/agent-answers.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteRecord } from '../stores/notes.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { questionWindow, type QuestionInput } from './questions.ts';

/** The days from `from` to `to` that an event on one of the location's calendars plainly says it was closed. */
export async function calendarClosedDays(
  ctx: Pick<TownwiseContext, 'stores'>, scope: OrgScope, locationId: string, range: { from: string; to: string }, today: string,
): Promise<string[]> {
  const events = await ctx.stores.ownerCalendars.keyedEventsBetween(scope, locationId, range);
  return [...closedDaysOf(closedEventsOf(events, today)).keys()].filter((day) => day >= range.from && day <= range.to);
}

/** The questions' input at the location now, with the records it came from. */
export async function questionInputAt(ctx: Pick<TownwiseContext, 'stores' | 'now'>, scope: OrgScope, location: LocationRecord): Promise<{
  input: QuestionInput; notes: NoteRecord[]; answers: AnswerRecord[];
}> {
  const [coverage, notes, answers, scheduled] = await Promise.all([
    ctx.stores.salesDays.coverage(scope, location.id),
    ctx.stores.notes.list(scope, location.id),
    ctx.stores.agentAnswers.list(scope, location.id),
    ctx.stores.businessRules.scheduled(scope, location.id),
  ]);
  const today = localDay(ctx.now(), timeZoneOf(location.town).timeZone);
  const window = questionWindow(coverage);
  // The days read reach 56 days before the window, for each day's typical guests (D32). D28: a turned-off upload's days
  // are left out of `days` and explained by `turnedOff`, so they are never asked about.
  const [days, turnedOff, calendarClosed] = window === null ? [[], [], []] : await Promise.all([
    ctx.stores.salesDays.days(scope, location.id, {
      from: utcDay(new Date(`${window.from}T00:00:00.000Z`), -TYPICAL_LOOKBACK_DAYS), to: window.to,
    }),
    ctx.stores.salesDays.disabledDates(scope, location.id, window),
    calendarClosedDays(ctx, scope, location.id, window, today),
  ]);
  // A save still in progress is not answered yet: the question stays until its answer is done.
  const answered = answers.filter((row) => row.status === 'done').map((row) => row.questionId);
  // D31: a business rule's schedule explains a day only as it decides it (questions.ts); a rule with none, nothing.
  const rules = scheduled.flatMap((rule) => (rule.schedule === null ? [] : [rule.schedule]));
  return { input: { coverage, days, notes, rules, answered, turnedOff, calendarClosed, today }, notes, answers };
}
