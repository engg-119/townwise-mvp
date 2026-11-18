import { AccessibilityInfo, Text } from 'react-native';
import { act, render, screen, userEvent } from '@testing-library/react-native';

import { InlineNotice, Notice } from '../../../src/portal/ui/feedback';
import { ToastHost } from '../../../src/portal/ui/toast';

// Toasts on native (spec 15.7, D55), from the same file as the web: a notice under the host is a toast in the polite
// live region and no row in the page, iOS is told its words, it leaves after 6 seconds or by its Dismiss button, and
// without a host it is the row it always was.

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a notice under the host is a toast that iOS is told, and it leaves after 6 seconds', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  await render(<ToastHost><Text>Notes</Text><Notice text="Deleted the note." /></ToastHost>);
  expect(screen.getAllByText('Deleted the note.')).toHaveLength(1);
  expect(screen.getByTestId('toast-text').props.children).toContain('Deleted the note.');
  expect(screen.queryByText('01')).toBeNull();
  expect(screen.getByTestId('toasts').props.role).toBe('status');
  expect(screen.getByTestId('toasts').props['aria-live']).toBe('polite');
  expect(announce).toHaveBeenCalledTimes(1);
  expect(announce).toHaveBeenCalledWith('Deleted the note.');
  await act(() => { jest.advanceTimersByTime(5999); });
  expect(screen.queryByText('Deleted the note.')).not.toBeNull();
  await act(() => { jest.advanceTimersByTime(1); });
  expect(screen.queryByText('Deleted the note.')).toBeNull();
});

test('Dismiss takes a toast away at once', async () => {
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  await render(<ToastHost><Notice text="Saved." /></ToastHost>);
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  await user.press(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('Saved.')).toBeNull();
});

test('without a host a notice is the row in the page, and an inline notice is a row under a host too', async () => {
  const view = await render(<Notice text="Saved." />);
  expect(screen.getByText('Saved.').props.role).toBe('status');
  expect(screen.getByText('01')).toBeTruthy();
  expect(screen.queryByTestId('toast')).toBeNull();
  await view.rerender(<ToastHost><InlineNotice text="This location isn’t available." /></ToastHost>);
  expect(screen.getByText('This location isn’t available.').props.role).toBe('status');
  expect(screen.queryByTestId('toast')).toBeNull();
});
