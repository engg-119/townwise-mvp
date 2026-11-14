import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ICS_COPY, IcsImport } from '../../../src/portal/calendar/IcsImport.web';
import type { ImportedCalendar } from '../../../src/portal/calendar/model';

// The import control in the Calendar's header row on web (P28, spec 16.3 and 17): "Import a calendar file" opens the
// file picker and is described by the help; "How importing works" shows or hides that help on a full-width line under
// the row, where it stays in the DOM while hidden. The import's result and refusals show on that line whether the help
// is open or not. Made-up file names only.

afterEach(cleanup);

const KITCHEN: ImportedCalendar = {
  fileName: 'kitchen.ics', skipped: 0,
  events: [
    { uid: 'i1', title: 'Wine delivery', startDate: '2026-11-21', endDate: '2026-11-21', startTime: null, endTime: null },
    { uid: 'i2', title: 'Linen pickup', startDate: '2026-11-22', endDate: '2026-11-22', startTime: null, endTime: null },
  ],
};

function renderImport(imported: ImportedCalendar | null = null): void {
  render(<IcsImport today="2026-11-11" imported={imported} onImport={() => undefined} />);
}

function shown(element: Element): boolean {
  for (let at: Element | null = element; at !== null; at = at.parentElement) {
    if (window.getComputedStyle(at).display === 'none') return false;
  }
  return true;
}

test('the help starts hidden but present, named by the disclosure and describing the import button', () => {
  renderImport();
  const toggle = screen.getByRole('button', { name: 'How importing works' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  const help = screen.getByText(ICS_COPY.help);
  expect(help.id).not.toBe('');
  expect(toggle.getAttribute('aria-controls')).toBe(help.id);
  expect(screen.getByRole('button', { name: 'Import a calendar file' }).getAttribute('aria-describedby')).toBe(help.id);
  expect(shown(help)).toBe(false);
});

test('pressing How importing works shows the help, and pressing it again hides it', () => {
  renderImport();
  const toggle = screen.getByRole('button', { name: 'How importing works' });
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(shown(screen.getByText(ICS_COPY.help))).toBe(true);
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(shown(screen.getByText(ICS_COPY.help))).toBe(false);
});

test('a result and a refusal show while the help is closed', async () => {
  renderImport(KITCHEN);
  expect(shown(screen.getByText('2 events from kitchen.ics.'))).toBe(true);
  expect(shown(screen.getByText(ICS_COPY.help))).toBe(false);
  cleanup();
  renderImport();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  const big = new File(['x'], 'everything.ics', { type: 'text/calendar' });
  Object.defineProperty(big, 'size', { value: 1024 * 1024 + 1 });
  fireEvent.change(input, { target: { files: [big] } });
  const refusal = await screen.findByText(ICS_COPY.tooLarge);
  expect(shown(refusal)).toBe(true);
  expect(shown(screen.getByText(ICS_COPY.help))).toBe(false);
});

test('the help and the messages share one full-width line, the control’s last piece', () => {
  renderImport(KITCHEN);
  const line = screen.getByText(ICS_COPY.help).parentElement;
  if (line === null) throw new Error('no line');
  expect(line.contains(screen.getByText('2 events from kitchen.ics.'))).toBe(true);
  expect(window.getComputedStyle(line).flexBasis).toBe('100%');
  expect(line.nextElementSibling).toBeNull();
});
