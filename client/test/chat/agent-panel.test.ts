import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { answerQuestion, loadAgentPanel } from '../../src/chat/api';
import { fakeChatApi } from '../helpers/chat';

// The side panel's answers exactly as the API sends them: agent-panel.json is a byte-for-byte copy of
// api/test/fixtures/agent-panel.json, which api/test/agent.int.test.ts asserts GET .../agent and
// POST .../agent/questions/:questionId answer (and that the two files are identical). A change to the server's shapes
// or to these schemas fails one side until both agree.
const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[] };
  answer: { questionId: string; body: { answer: 'closed' | 'open' | 'not_sure' }; response: unknown };
};

test('the fixture holds both question kinds and every activity kind the API sends', () => {
  expect(fixture.panel.questions.map((q) => (q as { kind: string }).kind)).toEqual(['weekday', 'gap']);
  expect(fixture.panel.activity.map((a) => (a as { kind: string }).kind)).toEqual(['note_saved', 'question_answered', 'upload_applied']);
});

test('the side panel reads every question and activity item the API answers, dropping none', async () => {
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
