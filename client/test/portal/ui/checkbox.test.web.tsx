import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Checkbox } from '../../../src/portal/ui';

// The shared checkbox on web (home.md 4.2, spec 15.7): a real <input type="checkbox"> inside its <label>, so the
// whole row toggles it; disabled it keeps its focus with aria-disabled, never the attribute, and ignores changes.

afterEach(() => {
  cleanup();
});

test('a real checkbox named by its label; clicking the label asks for the other state', () => {
  const onChange = jest.fn();
  render(<Checkbox label="Closed days" checked={false} onChange={onChange} describedBy="help" />);
  const box = screen.getByRole('checkbox', { name: 'Closed days' });
  expect(box.tagName).toBe('INPUT');
  expect(box.getAttribute('type')).toBe('checkbox');
  expect(box.closest('label')?.textContent).toBe('Closed days');
  expect(box.getAttribute('aria-describedby')).toBe('help');
  fireEvent.click(screen.getByText('Closed days'));
  expect(onChange).toHaveBeenCalledWith(true);
});

test('disabled: focusable, aria-disabled and not the attribute, and a click changes nothing', () => {
  const onChange = jest.fn();
  render(<Checkbox label="2026" checked disabled onChange={onChange} />);
  const box = screen.getByRole<HTMLInputElement>('checkbox', { name: '2026' });
  expect(box.getAttribute('aria-disabled')).toBe('true');
  expect(box.hasAttribute('disabled')).toBe(false);
  box.focus();
  expect(document.activeElement).toBe(box);
  fireEvent.click(box);
  expect(onChange).not.toHaveBeenCalled();
  expect(box.checked).toBe(true);
});
