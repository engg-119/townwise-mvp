import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { answerQuestion, decideSuggestion, loadAgentPanel, setWeeklySuggestions, type QuestionAnswer } from '../../src/chat/api';
import { fakeChatApi } from '../helpers/chat';

// The side panel's answers exactly as the API sends them: agent-panel.json is a byte-for-byte copy of
// api/test/fixtures/agent-panel.json, which api/test/agent.int.test.ts asserts GET .../agent and
// POST .../agent/questions/:questionId answer (and that the two files are identical). A change to the server's shapes
// or to these schemas fails one side until both agree.
const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[]; suggestions: unknown[]; weeklySuggestions: unknown };
  answer: { questionId: string; body: { answer: QuestionAnswer }; response: unknown };
};

test('the fixture holds every question kind and every activity kind the API sends', () => {
  expect(fixture.panel.questions.map((q) => (q as { kind: string }).kind)).toEqual(['weekday', 'likely_closed', 'gap']);
  expect(fixture.panel.activity.map((a) => (a as { kind: string }).kind)).toEqual([
    'note_saved', 'question_answered', 'upload_applied', 'file_processed', 'question_answered',
  ]);
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

test('an answer sends the body the API takes and reads the response it gives', async () => {
  const api = fakeChatApi();
  const path = `/api/org/locations/l1/agent/questions/${fixture.answer.questionId}`;
  api.respond[path] = () => fixture.answer.response;
  expect(await answerQuestion(api, 'l1', fixture.answer.questionId, fixture.answer.body.answer)).toEqual(fixture.answer.response);
  expect(api.writes).toEqual([{ method: 'POST', path, body: fixture.answer.body }]);
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

test('the fixture holds a weekly suggestion of each type and the organization’s switch', () => {
  expect(fixture.panel.suggestions.map((s) => (s as { type: string }).type)).toEqual(['rule', 'note']);
  expect(fixture.panel.weeklySuggestions).toEqual({ on: true, available: false, canChange: false });
});

test('an API from before weekly suggestions reads as none, and a suggestion this client does not know is left out', async () => {
  const api = fakeChatApi();
  api.panel = { questions: [], activity: [], suggestions: [{ id: 's9', type: 'reminder', why: 'x', calendar: [], createdAt: '' }] };
  expect(await loadAgentPanel(api, 'l1')).toEqual({ questions: [], activity: [], suggestions: [], weeklySuggestions: null });
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
