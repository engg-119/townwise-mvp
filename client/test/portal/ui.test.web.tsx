import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { Button } from '../../src/portal/ui/Button';
import { ConfirmDialog, type ConfirmDialogProps } from '../../src/portal/ui/ConfirmDialog';
import { Notice } from '../../src/portal/ui/feedback';
import { MessageFocus, useFocusMessage } from '../../src/portal/ui/messageFocus';

// The shared controls on web, where keyboard focus is real (spec 15.7): a disabled control stays the same focusable
// element, and a dialog whose action is running can't be closed until it answers.

afterEach(() => {
  cleanup();
});

function escape(): void {
  act(() => { document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' })); });
}

test('a button that turns disabled keeps its element and its focus: aria-disabled, never the attribute, and presses do nothing', () => {
  const onPress = jest.fn();
  const view = render(<Button label="Save name" onPress={onPress} />);
  const button = screen.getByRole('button', { name: 'Save name' });
  button.focus();
  view.rerender(<Button label="Save name" disabled onPress={onPress} />);
  expect(screen.getByRole('button', { name: 'Save name' })).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(button.tabIndex).toBe(0);
  fireEvent.click(button);
  expect(onPress).not.toHaveBeenCalled();

  view.rerender(<Button label="Save name" onPress={onPress} />);
  expect(button.getAttribute('aria-disabled')).toBeNull();
  fireEvent.click(button);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('a disclosure button has aria-expanded and aria-controls, and a button without them has neither', () => {
  const view = render(<Button variant="outline" label="Your calendars" expanded={false} controls="p1" onPress={() => undefined} />);
  const button = screen.getByRole('button', { name: 'Your calendars' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(button.getAttribute('aria-controls')).toBe('p1');
  view.rerender(<Button variant="outline" label="Your calendars" expanded controls="p1" onPress={() => undefined} />);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(button.getAttribute('aria-controls')).toBe('p1');
  cleanup();
  render(<Button variant="outline" label="Check again" onPress={() => undefined} />);
  const plain = screen.getByRole('button', { name: 'Check again' });
  expect(plain.hasAttribute('aria-expanded')).toBe(false);
  expect(plain.hasAttribute('aria-controls')).toBe(false);
});

test('a button with focusOnMount takes focus as it mounts, and one already showing never takes it back', () => {
  const view = render(<Button variant="outline" label="Add a link" focusOnMount={false} onPress={() => undefined} />);
  const button = screen.getByRole('button', { name: 'Add a link' });
  expect(document.activeElement).not.toBe(button);
  view.rerender(<Button variant="outline" label="Add a link" focusOnMount onPress={() => undefined} />);
  expect(document.activeElement).not.toBe(button);
  cleanup();
  render(<Button variant="outline" label="Add a link" focusOnMount onPress={() => undefined} />);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a link' }));
});

function dialog(props: Partial<ConfirmDialogProps> & Pick<ConfirmDialogProps, 'onCancel'>): React.JSX.Element {
  return (
    <ConfirmDialog visible title="Remove the invitation?" body="They can’t join with it anymore." confirmLabel="Remove" pendingLabel="Removing…" onConfirm={() => undefined} {...props} />
  );
}

test('ConfirmDialog: the primary keeps focus as its action starts, and Cancel and Escape wait until it answers', () => {
  const onCancel = jest.fn();
  const view = render(dialog({ onCancel }));
  const primary = within(screen.getByRole('dialog', { name: 'Remove the invitation?' })).getByRole('button', { name: 'Remove' });
  primary.focus();
  view.rerender(dialog({ onCancel, pending: true }));
  expect(within(screen.getByRole('dialog', { name: 'Remove the invitation?' })).getByRole('button', { name: 'Removing…' })).toBe(primary);
  expect(document.activeElement).toBe(primary);

  const cancel = within(screen.getByRole('dialog', { name: 'Remove the invitation?' })).getByRole('button', { name: 'Cancel' });
  expect(cancel.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(cancel);
  escape();
  expect(onCancel).not.toHaveBeenCalled();

  view.rerender(dialog({ onCancel }));
  expect(cancel.getAttribute('aria-disabled')).toBeNull();
  escape();
  expect(onCancel).toHaveBeenCalledTimes(1);
  fireEvent.click(cancel);
  expect(onCancel).toHaveBeenCalledTimes(2);
});

test('focusMessage() from a page that has gone does nothing, so an answer that lands later never moves focus on the next page', () => {
  let focusMessage: () => void = () => undefined;
  function Caller(): null {
    focusMessage = useFocusMessage();
    return null;
  }
  const view = render(<MessageFocus><Caller /><Notice text="Saved." /></MessageFocus>);
  // The calling page is gone (staff went Back to another console page); a message and a field are on the next one.
  view.rerender(<MessageFocus><Notice text="Saved." /><input aria-label="Search" /></MessageFocus>);
  const field = screen.getByRole('textbox', { name: 'Search' });
  field.focus();
  act(() => { focusMessage(); });
  expect(document.activeElement).toBe(field);
});

test('focusMessage() from a page still showing moves focus to its message', () => {
  let focusMessage: () => void = () => undefined;
  function Caller(): React.JSX.Element {
    focusMessage = useFocusMessage();
    return <input aria-label="Search" />;
  }
  render(<MessageFocus><Caller /><Notice text="Saved." /></MessageFocus>);
  screen.getByRole('textbox', { name: 'Search' }).focus();
  act(() => { focusMessage(); });
  expect(document.activeElement?.textContent).toBe('01Saved.');
});
