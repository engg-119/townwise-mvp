import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { answerQuestion, decideSuggestion, loadAgentPanel, setCalendarTitles, setWeeklySuggestions, type QuestionAnswer } from '../../src/chat/api';
import { alreadyDecidedRule, decideRuleSuggestion, fetchRules } from '../../src/portal/rules/api';
import { ApiError } from '../../src/api/client';
import { fakeChatApi } from '../helpers/chat';

// The side panel's answers exactly as the API sends them: agent-panel.json is a byte-for-byte copy of
// api/test/fixtures/agent-panel.json, which api/test/agent.int.test.ts asserts GET .../agent and
// POST .../agent/questions/:questionId answer (and that the two files are identical). A change to the server's shapes
// or to these schemas fails one side until both agree.
const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[]; suggestions: unknown[]; weeklySuggestions: unknown; ruleSuggestions: unknown[] };
  answer: { questionId: string; body: { answer: QuestionAnswer }; response: unknown };
  partyGuests: {
    questions: unknown[]; activity: unknown[]; answer: { questionId: string; body: { answer: 'guests'; guests: number }; response: unknown };
  };
};

test('the fixture holds every question kind and every activity kind the API sends', () => {
  // D46: the sales history's weekday question became a suggested rule, so the API sends no weekday question.
  expect(fixture.panel.questions.map((q) => (q as { kind: string }).kind)).toEqual(['likely_closed', 'gap']);
  expect(fixture.panel.activity.map((a) => (a as { kind: string }).kind)).toEqual([
    'note_saved', 'question_answered', 'upload_applied', 'file_processed', 'forecast_made', 'agent_change', 'question_answered',
  ]);
  // D71: a past private event's guests, and the count saved from one, held apart so the panel's cards stay as they were.
  expect(fixture.partyGuests.questions.map((q) => (q as { kind: string }).kind)).toEqual(['party_guests']);
  expect(fixture.partyGuests.activity.map((a) => (a as { kind: string }).kind)).toEqual(['guest_count_saved']);
  // Every answer an activity item can name, `other` (Something else…) included.
  expect(fixture.panel.activity.flatMap((a) => {
    const item = a as { kind: string; answer?: string };
    return item.kind === 'question_answered' ? [item.answer] : [];
  })).toEqual(['not_sure', 'other']);
});

test('the side panel reads every question and activity item the API answers, dropping none and no field', async () => {
  const api = fakeChatApi();
  api.panel = fixture.panel;
  expect(await loadAgentPanel(api, 'l1')).toEqual(fixture.panel);
});

test('D65: a forecast run with a cause, reason or outcome this client does not know is left out, and the rest kept', async () => {
  const api = fakeChatApi();
  const run = fixture.panel.activity.find((a) => (a as { kind: string }).kind === 'forecast_made') as Record<string, unknown>;
  api.panel = {
    ...fixture.panel,
    activity: [run, { ...run, causes: ['research'] }, { ...run, reason: 'later_reason' }, { ...run, outcome: 'paused' }, { ...run, dayCount: undefined }],
  };
  expect((await loadAgentPanel(api, 'l1')).activity).toEqual([run]);
});

test('D66: research runs and TownwiseAI’s corrections read as the API sends them; an unknown status or subject is left out', async () => {
  // Shapes copied from api/test/agent-activity.test.ts (research_done) and api/src/agent/activity.ts (an event.correct
  // change: no dates, kind or count). The shared fixture is unchanged; these items sit beside it.
  const done = {
    at: '2026-06-01T09:00:00.000Z', kind: 'research_done', subject: 'location', status: 'done', found: 9, added: 3, competitors: 2, threadsFailed: 0,
    threadsBudget: 0, finishedAt: '2026-06-01T09:00:00.000Z',
  };
  const town = { ...done, subject: 'town', status: 'budget', found: 0, added: 0, competitors: null, threadsFailed: 3, threadsBudget: 3 };
  const corrected = {
    at: '2026-06-01T08:30:00.000Z', kind: 'agent_change', changeId: '0000000000000000000000e9', action: 'event.correct', sourceKind: 'chat',
    status: 'applied', startDate: null, endDate: null, noteKind: null, weekdays: null, count: null, undoable: true, sourcePasted: false,
  };
  const api = fakeChatApi();
  api.panel = {
    ...fixture.panel,
    activity: [done, town, corrected, { ...done, status: 'off' }, { ...done, subject: 'region' }, { ...corrected, action: 'event.later' }],
  };
  expect((await loadAgentPanel(api, 'l1')).activity).toEqual([done, town, corrected]);
  // An item from an API before threadsBudget reads as none skipped for budget.
  const older: Record<string, unknown> = { ...done };
  delete older.threadsBudget;
  api.panel = { ...fixture.panel, activity: [older] };
  expect((await loadAgentPanel(api, 'l1')).activity).toEqual([done]);
});

test('an answer sends the body the API takes and reads the response it gives', async () => {
  const api = fakeChatApi();
  const path = `/api/org/locations/l1/agent/questions/${fixture.answer.questionId}`;
  api.respond[path] = () => fixture.answer.response;
  expect(await answerQuestion(api, 'l1', fixture.answer.questionId, fixture.answer.body.answer)).toEqual(fixture.answer.response);
  expect(api.writes).toEqual([{ method: 'POST', path, body: fixture.answer.body }]);
});

test('D71: the panel reads a private event’s question and a saved count exactly as the API sends them', async () => {
  const api = fakeChatApi();
  api.panel = { ...fixture.panel, questions: fixture.partyGuests.questions, activity: fixture.partyGuests.activity };
  const read = await loadAgentPanel(api, 'l1');
  expect({ questions: read.questions, activity: read.activity }).toEqual({
    questions: fixture.partyGuests.questions, activity: fixture.partyGuests.activity,
  });
});

test('D71: a private event’s count goes as `guests` beside the answer, and Skip as `not_sure` alone', async () => {
  const api = fakeChatApi();
  const { questionId, body, response } = fixture.partyGuests.answer;
  const path = `/api/org/locations/l1/agent/questions/${questionId}`;
  api.respond[path] = () => response;
  expect(await answerQuestion(api, 'l1', questionId, 'guests', body.guests)).toEqual(response);
  api.respond[path] = () => ({ question: { id: questionId, answer: 'not_sure' }, note: null });
  await answerQuestion(api, 'l1', questionId, 'not_sure');
  expect(api.writes).toEqual([
    { method: 'POST', path, body: { answer: 'guests', guests: 43 } }, { method: 'POST', path, body: { answer: 'not_sure' } },
  ]);
});

test('Something else… answers `other` with that one key and reads it back', async () => {
  const api = fakeChatApi();
  const path = `/api/org/locations/l1/agent/questions/${fixture.answer.questionId}`;
  api.respond[path] = () => ({ question: { id: fixture.answer.questionId, answer: 'other' }, note: null });
  expect(await answerQuestion(api, 'l1', fixture.answer.questionId, 'other')).toEqual({
    question: { id: fixture.answer.questionId, answer: 'other' }, note: null,
  });
  expect(api.writes).toEqual([{ method: 'POST', path, body: { answer: 'other' } }]);
});

test('the fixture holds a weekly suggestion of each type and the organization’s switches', () => {
  expect(fixture.panel.suggestions.map((s) => (s as { type: string }).type)).toEqual(['rule', 'note', 'event', 'move', 'remove']);
  expect(fixture.panel.weeklySuggestions).toEqual({ on: true, available: false, canChange: false, calendarTitles: true });
});

test('an API from before calendar titles reads the switch without them', async () => {
  const api = fakeChatApi();
  api.panel = { ...fixture.panel, weeklySuggestions: { on: true, available: true, canChange: true } };
  expect((await loadAgentPanel(api, 'l1')).weeklySuggestions).toEqual({ on: true, available: true, canChange: true });
});

test('an API from before weekly suggestions reads as none, and a suggestion this client does not know is left out', async () => {
  const api = fakeChatApi();
  api.panel = { questions: [], activity: [], suggestions: [{ id: 's9', type: 'reminder', why: 'x', calendar: [], createdAt: '' }] };
  expect(await loadAgentPanel(api, 'l1')).toEqual({
    questions: [], activity: [], suggestions: [], weeklySuggestions: null, ruleSuggestions: [],
    // D59: an API from before TownwiseAI worked on its own.
    agentAuto: null, noteSuggestions: [], waiting: 0,
  });
});

test('accepting or dismissing a suggestion sends an empty body to its route', async () => {
  const api = fakeChatApi();
  const accept = '/api/org/locations/l1/agent/suggestions/s1/accept';
  const dismiss = '/api/org/locations/l1/agent/suggestions/s2/dismiss';
  api.respond[accept] = () => ({ suggestion: { id: 's1', status: 'accepted' }, note: null, rule: null });
  api.respond[dismiss] = () => ({ suggestion: { id: 's2', status: 'dismissed' }, note: null, rule: null });
  expect(await decideSuggestion(api, 'l1', 's1', 'accept')).toEqual({ suggestion: { id: 's1', status: 'accepted' }, note: null, rule: null });
  expect(await decideSuggestion(api, 'l1', 's2', 'dismiss')).toEqual({ suggestion: { id: 's2', status: 'dismissed' }, note: null, rule: null });
  expect(api.writes).toEqual([{ method: 'POST', path: accept, body: {} }, { method: 'POST', path: dismiss, body: {} }]);
});

test('accepting a spotted event sends the admin’s choice and count; its dismiss and every other accept send {}', async () => {
  const api = fakeChatApi();
  const accept = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c4/accept';
  const dismiss = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c4/dismiss';
  const move = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c5/accept';
  const answer = (id: string, status: string) => () => ({ suggestion: { id, status }, note: null, rule: null });
  api.respond[accept] = answer('0000000000000000000000c4', 'accepted');
  api.respond[dismiss] = answer('0000000000000000000000c4', 'dismissed');
  api.respond[move] = answer('0000000000000000000000c5', 'accepted');
  await decideSuggestion(api, 'l1', '0000000000000000000000c4', 'accept', { effect: 'closed', expectedGuests: null });
  await decideSuggestion(api, 'l1', '0000000000000000000000c4', 'accept', { effect: 'more_guests', expectedGuests: 40 });
  await decideSuggestion(api, 'l1', '0000000000000000000000c4', 'dismiss');
  await decideSuggestion(api, 'l1', '0000000000000000000000c5', 'accept');
  expect(api.writes).toEqual([
    { method: 'POST', path: accept, body: { effect: 'closed', expectedGuests: null } },
    { method: 'POST', path: accept, body: { effect: 'more_guests', expectedGuests: 40 } },
    { method: 'POST', path: dismiss, body: {} },
    { method: 'POST', path: move, body: {} },
  ]);
});

test('the titles switch sends { on }, and the tab’s orgId in open as admin', async () => {
  const api = fakeChatApi();
  const path = '/api/org/weekly-suggestions/calendar-titles';
  api.respond[path] = (body) => ({ calendarTitles: { on: (body as { on: boolean }).on } });
  expect(await setCalendarTitles(api, false, null)).toBe(false);
  expect(await setCalendarTitles(api, false, 'o1')).toBe(false);
  expect(api.writes).toEqual([
    { method: 'PATCH', path, body: { on: false } },
    { method: 'PATCH', path, body: { on: false, orgId: 'o1' } },
  ]);
});

test('the switch sends { on }, and the tab’s orgId in open as admin', async () => {
  const api = fakeChatApi();
  api.respond['/api/org/weekly-suggestions'] = (body) => ({ weeklySuggestions: { on: (body as { on: boolean }).on } });
  expect(await setWeeklySuggestions(api, false, null)).toBe(false);
  expect(await setWeeklySuggestions(api, true, 'o1')).toBe(true);
  expect(api.writes).toEqual([
    { method: 'PATCH', path: '/api/org/weekly-suggestions', body: { on: false } },
    { method: 'PATCH', path: '/api/org/weekly-suggestions', body: { on: true, orgId: 'o1' } },
  ]);
});

test('the fixture holds a suggested rule from a file and one from the sales history (D46)', () => {
  expect(fixture.panel.ruleSuggestions.map((s) => (s as { source: string }).source)).toEqual(['file', 'sales']);
});

test('a weekday question from an API before D46, and a suggested rule from a source this client does not know, are left out', async () => {
  const api = fakeChatApi();
  const weekday = { id: 'weekday_1_2026-03-01_2026-05-31', kind: 'weekday', weekday: 1, from: '2026-03-01', to: '2026-05-31', noSalesCount: 13, weekdayCount: 13 };
  const [file] = fixture.panel.ruleSuggestions;
  api.panel = { ...fixture.panel, questions: [weekday], ruleSuggestions: [file, { ...(file as object), id: 'x', source: 'weekly' }] };
  const panel = await loadAgentPanel(api, 'l1');
  expect(panel.questions).toEqual([]);
  expect(panel.ruleSuggestions).toEqual([file]);
});

test('GET .../rules reads `suggested` with the same schema, and an API before D46 reads as none', async () => {
  const api = fakeChatApi();
  api.reads['/api/org/locations/l1/rules'] = () => ({ rules: [], limit: 30, suggested: fixture.panel.ruleSuggestions });
  expect(await fetchRules(api, 'l1')).toEqual({ rules: [], limit: 30, suggested: fixture.panel.ruleSuggestions });
  api.reads['/api/org/locations/l1/rules'] = () => ({ rules: [], limit: 30 });
  expect(await fetchRules(api, 'l1')).toEqual({ rules: [], limit: 30, suggested: [] });
});

test('Confirm and Dismiss send an empty body, and Edit sends the rule, to the suggested rules’ own routes', async () => {
  const api = fakeChatApi();
  const base = '/api/org/locations/l1/agent/rule-suggestions';
  api.respond[`${base}/sales_weekday_1/accept`] = () => ({ suggestion: { id: 'n1', status: 'accepted' }, rule: null });
  api.respond[`${base}/d1/accept`] = () => ({ suggestion: { id: 'd1', status: 'accepted' }, rule: null });
  api.respond[`${base}/d2/dismiss`] = () => ({ suggestion: { id: 'd2', status: 'dismissed' }, rule: null });
  expect(await decideRuleSuggestion(api, 'l1', 'sales_weekday_1', 'accept')).toEqual({ suggestion: { id: 'n1', status: 'accepted' }, rule: null });
  const schedule = {
    kind: 'closure' as const, startDate: '2027-01-01', endDate: null, weekdays: null, effect: 'closed' as const, expectedGuests: null,
    startTime: null, endTime: null, season: { repeat: 'yearly' as const, from: '01-01', to: '03-31' },
  };
  await decideRuleSuggestion(api, 'l1', 'd1', 'accept', { text: 'Closed in winter', schedule });
  await decideRuleSuggestion(api, 'l1', 'd2', 'dismiss');
  expect(api.writes).toEqual([
    { method: 'POST', path: `${base}/sales_weekday_1/accept`, body: {} },
    { method: 'POST', path: `${base}/d1/accept`, body: { rule: { text: 'Closed in winter', schedule } } },
    { method: 'POST', path: `${base}/d2/dismiss`, body: {} },
  ]);
});

test('409 already_decided carries the stored rule', () => {
  const rule = {
    id: 'd1', text: 'Closed on Tuesdays', addedVia: 'townwise_ai', createdByEmail: 'owner@example.com', createdAt: '2026-11-17T15:00:00.000Z',
    updatedAt: '2026-11-17T15:00:00.000Z', canEdit: true,
  };
  expect(alreadyDecidedRule(new ApiError('http', 'x', { status: 409, code: 'already_decided', detail: { rule } }))).toEqual(rule);
  expect(alreadyDecidedRule(new ApiError('http', 'x', { status: 409, code: 'rule_exists', detail: { rule } }))).toBeNull();
  expect(alreadyDecidedRule(new Error('x'))).toBeNull();
});
