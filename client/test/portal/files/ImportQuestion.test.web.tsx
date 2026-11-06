import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ImportQuestion } from '../../../src/portal/files/ImportQuestion';
import type { ImportView, QuestionView } from '../../../src/portal/files/api';
import type { MeResponse } from '../../../src/portal/schemas';
import { ACCESS, meOf, refusal, viewAsMe } from '../../helpers/portal';
import { filesFake, importViewOf, LOCATION, type FilesFake } from './fakes';
import { portalWrapper } from './harness';

// A question that pauses an import (storage 1.3, storage2 2.2): it says what Townwise needs and what the answer
// does, picks the suggested option, offers Not sure with what that does, names a ZIP's table, and posts the
// answer. Under view-as Continue stays focusable with aria-disabled and the read-only line.

afterEach(() => {
  cleanup();
});

function questionOf(extra?: Partial<QuestionView>): QuestionView {
  return {
    id: 'q1', fileId: 'f1', fileName: 'march.csv', kind: 'date_column',
    options: [{ id: '0', label: 'Order Date' }, { id: '3', label: 'Business Date' }, { id: 'not_sure', label: 'not_sure' }],
    suggested: '3', family: null, ...extra,
  };
}

async function show(question: QuestionView, me: MeResponse = meOf(ACCESS.admin)): Promise<{ fake: FilesFake; answered: ImportView[] }> {
  const fake = filesFake();
  const answered: ImportView[] = [];
  const Wrapper = portalWrapper(fake, me);
  render(
    <Wrapper>
      <ImportQuestion locationId={LOCATION} importId="i1" question={question} locationName="Main Street Bar" onAnswered={(view) => { answered.push(view); }} />
    </Wrapper>,
  );
  await screen.findByRole('heading');
  return { fake, answered };
}

const pressed = (name: string): string | null => screen.getByRole('button', { name }).getAttribute('aria-pressed');

test('says what Townwise needs and what the answer does, with the suggested column picked', async () => {
  const { fake, answered } = await show(questionOf());
  expect(screen.getByRole('heading', { name: 'Which column has the date of each sale?' })).toBeTruthy();
  expect(screen.getByText(/Townwise adds up each day from this column/)).toBeTruthy();
  expect(screen.getByText('march.csv')).toBeTruthy();
  expect(pressed('Business Date')).toBe('true');
  expect(pressed('Order Date')).toBe('false');
  fake.answers['POST /imports/i1/answer'] = () => ({ import: importViewOf('i1', { status: 'queued' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => { expect(answered).toHaveLength(1); });
  expect(fake.calls.find((call) => call.path === '/imports/i1/answer')?.body).toEqual({ questionId: 'q1', choice: '3' });
});

test('Not sure says it keeps the file stored but not used', async () => {
  const { fake } = await show(questionOf({ suggested: null }));
  expect(screen.queryByText(/stored but not used/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Not sure' }));
  expect(screen.getByText('Not sure keeps this file stored but not used, and Townwise moves on to the next one.')).toBeTruthy();
  fake.answers['POST /imports/i1/answer'] = () => ({ import: importViewOf('i1', { status: 'queued' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => { expect(fake.calls.find((call) => call.path === '/imports/i1/answer')?.body).toEqual({ questionId: 'q1', choice: 'not_sure' }); });
});

test('columns asks for guests and net sales together; one may be left out, not both', async () => {
  const { fake } = await show(questionOf({
    kind: 'columns', suggested: null, family: 'Date, Covers, Net Amount',
    options: [
      { id: 'guests:3', label: 'Covers' }, { id: 'guests:none', label: 'none' },
      { id: 'netSales:7', label: 'Net Amount' }, { id: 'netSales:none', label: 'none' }, { id: 'not_sure', label: 'not_sure' },
    ],
  }));
  expect(screen.getByText('In the table with Date, Covers, Net Amount')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('Choose a guests column, a net sales column, or both.')).toBeTruthy();
  expect(fake.calls).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Net Amount' }));
  fake.answers['POST /imports/i1/answer'] = () => ({ import: importViewOf('i1', { status: 'queued' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => {
    expect(fake.calls.find((call) => call.path === '/imports/i1/answer')?.body).toEqual({ questionId: 'q1', choice: 'guests:none,netSales:7' });
  });
});

test('enum questions are worded by the client: one row is a day, a check or an item', async () => {
  await show(questionOf({
    kind: 'row_mode', suggested: 'check',
    options: [{ id: 'day', label: 'day' }, { id: 'check', label: 'check' }, { id: 'item', label: 'item' }, { id: 'not_sure', label: 'not_sure' }],
  }));
  expect(screen.getByRole('heading', { name: 'What is one row in this file?' })).toBeTruthy();
  expect(pressed('One check or order')).toBe('true');
  expect(screen.getByRole('button', { name: 'One item' })).toBeTruthy();
});

test('a question that changed meanwhile says so', async () => {
  const { fake } = await show(questionOf());
  fake.answers['POST /imports/i1/answer'] = () => refusal(409, 'question_stale');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByText('This question changed. Here’s the new one.')).toBeTruthy();
});

test('under view-as the question shows, and Continue is disabled in place with the read-only line', async () => {
  const { fake } = await show(questionOf({ fileName: null }), viewAsMe(ACCESS.admin));
  const button = screen.getByRole('button', { name: 'Continue' });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.getAttribute('aria-describedby')).toBe('import-question-ro');
  expect(document.getElementById('import-question-ro')?.textContent).toBe('Read-only while viewing as gm@example.org.');
  fireEvent.click(button);
  expect(fake.calls).toHaveLength(0);
  expect(screen.queryByText('march.csv')).toBeNull();
});
