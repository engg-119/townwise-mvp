import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CALENDARS_COPY } from '../../../src/portal/calendar/calendars';
import { IcsImport } from '../../../src/portal/calendar/IcsImport.web';

// The calendar file picker on web (P28; connect-owner-calendar design decision 11), inside the "Your calendars" panel:
// "Import a calendar file" is described by the id the panel gives it and opens a hidden file input for .ics files,
// cleared after each choice. A file over 1 MB is refused unread; any other is read with File.text() and handed to the
// panel as its name and text, which the API parses. "Importing…" shows while the panel posts it. Made-up file names
// only.

afterEach(cleanup);

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Calendar//EN',
  'BEGIN:VEVENT', 'UID:i1', 'SUMMARY:Wine delivery', 'DTSTART;VALUE=DATE:20261121', 'DTEND;VALUE=DATE:20261122', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

function renderPicker(pending = false, readOnlyId: string | null = null): { onFile: jest.Mock; onRefusal: jest.Mock; input: HTMLInputElement } {
  const onFile = jest.fn();
  const onRefusal = jest.fn();
  render(<IcsImport describedBy="p1-help" pending={pending} readOnlyId={readOnlyId} onFile={onFile} onRefusal={onRefusal} />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  return { onFile, onRefusal, input };
}

/** `text` stands in for File.text(), which jsdom's Blob lacks; `size` for the file's size on disk. */
function fileOf(name: string, text: () => Promise<string>, size?: number): File {
  const file = new File(['x'], name, { type: 'text/calendar' });
  Object.defineProperty(file, 'text', { value: text });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

test('“Import a calendar file” is described by the id it is given and opens the file input for .ics files', () => {
  const { input } = renderPicker();
  const button = screen.getByRole('button', { name: 'Import a calendar file' });
  expect(button.getAttribute('aria-describedby')).toBe('p1-help');
  expect(input.getAttribute('accept')).toBe('.ics,text/calendar');
  const opened = jest.spyOn(input, 'click').mockImplementation(() => undefined);
  fireEvent.click(button);
  expect(opened).toHaveBeenCalledTimes(1);
});

test('a file over 1 MB calls onRefusal with the 1 MB words and is never read', () => {
  const { input, onFile, onRefusal } = renderPicker();
  const text = jest.fn(() => Promise.resolve(ICS));
  fireEvent.change(input, { target: { files: [fileOf('everything.ics', text, 1024 * 1024 + 1)] } });
  expect(onRefusal).toHaveBeenCalledWith(CALENDARS_COPY.tooLarge);
  expect(text).not.toHaveBeenCalled();
  expect(onFile).not.toHaveBeenCalled();
});

test('the input is cleared after each choice, so the same file can be chosen again', () => {
  const { input } = renderPicker();
  const cleared = jest.fn();
  Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: cleared });
  const big = (): File => fileOf('everything.ics', () => Promise.resolve(ICS), 1024 * 1024 + 1);
  fireEvent.change(input, { target: { files: [big()] } });
  fireEvent.change(input, { target: { files: [big()] } });
  expect(cleared.mock.calls).toEqual([[''], ['']]);
});

test('a file of at most 1 MB is read and handed on as its name and text, unparsed', async () => {
  const { input, onFile, onRefusal } = renderPicker();
  fireEvent.change(input, { target: { files: [fileOf('kitchen.ics', () => Promise.resolve(ICS), 1024 * 1024)] } });
  await waitFor(() => { expect(onFile).toHaveBeenCalledTimes(1); });
  expect(onFile).toHaveBeenCalledWith({ name: 'kitchen.ics', text: ICS });
  // What the API decides is a calendar: a CSV is handed on too.
  fireEvent.change(input, { target: { files: [fileOf('sales.csv', () => Promise.resolve('date,guests\n'))] } });
  await waitFor(() => { expect(onFile).toHaveBeenLastCalledWith({ name: 'sales.csv', text: 'date,guests\n' }); });
  expect(onRefusal).not.toHaveBeenCalled();
});

test('a file that can’t be read calls onRefusal with its words', async () => {
  const { input, onFile, onRefusal } = renderPicker();
  fireEvent.change(input, { target: { files: [fileOf('kitchen.ics', () => Promise.reject(new Error('gone')))] } });
  await waitFor(() => { expect(onRefusal).toHaveBeenCalledWith(CALENDARS_COPY.unreadable); });
  expect(onFile).not.toHaveBeenCalled();
});

test('under view-as the button is disabled in place, described by the help and the read-only line, and opens nothing', () => {
  const { input } = renderPicker(false, 'p1-ro');
  const button = screen.getByRole('button', { name: 'Import a calendar file' });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.getAttribute('aria-describedby')).toBe('p1-help p1-ro');
  const opened = jest.spyOn(input, 'click').mockImplementation(() => undefined);
  fireEvent.click(button);
  expect(opened).not.toHaveBeenCalled();
});

test('while the panel posts a file the button reads “Importing…”, disabled in place', () => {
  const { input } = renderPicker(true);
  const button = screen.getByRole('button', { name: 'Importing…' });
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.getAttribute('aria-describedby')).toBe('p1-help');
  const opened = jest.spyOn(input, 'click').mockImplementation(() => undefined);
  fireEvent.click(button);
  expect(opened).not.toHaveBeenCalled();
});
