import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { answerQuestion, loadAgentPanel, type QuestionAnswer } from '../../src/chat/api';
import { fakeChatApi } from '../helpers/chat';

// The side panel's answers exactly as the API sends them: agent-panel.json is a byte-for-byte copy of
// api/test/fixtures/agent-panel.json, which api/test/agent.int.test.ts asserts GET .../agent and
// POST .../agent/questions/:questionId answer (and that the two files are identical). A change to the server's shapes
// or to these schemas fails one side until both agree.
const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[] };
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
