import { AccessibilityInfo, StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import { Field, Message } from '../src/ui';

test('Field uses fontSize 16', async () => {
  const view = await render(<Field label="Email" />);
  const input = view.container.queryAll((instance) => instance.type === 'TextInput')[0];
  const style = StyleSheet.flatten(input?.props.style) as { fontSize?: number };
  expect(style.fontSize).toBe(16);
});

test('an error message is an alert, announced on iOS; other messages are not', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
  await render(<><Message>You’ve been signed out.</Message><Message tone="error">Too many attempts.</Message></>);
  expect(screen.getByText('Too many attempts.').props.role).toBe('alert');
  expect(screen.getByText('Too many attempts.').props['aria-live']).toBe('assertive');
  expect(screen.getByText('You’ve been signed out.').props.role).toBeUndefined();
  expect(announce.mock.calls).toEqual([['Too many attempts.']]);
  announce.mockRestore();
});
