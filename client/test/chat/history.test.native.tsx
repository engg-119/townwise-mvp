import { cleanup, render, screen, within } from '@testing-library/react-native';
import { Dimensions, StyleSheet } from 'react-native';

import { ChatHeader } from '../../src/chat/ui/ChatHeader';

afterEach(async () => {
  await cleanup();
  jest.restoreAllMocks();
});

it('the header wraps on phones and every control is a 44px icon named by its words, the count a badge', async () => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 390 });
  await render(
    <ChatHeader
      conversations={[]} openId={null} streaming={false} readOnlyId={null} panelOpen={false} openQuestions={2}
      onOpen={jest.fn()} onNew={jest.fn()} onDelete={jest.fn()} onRename={jest.fn()} onTogglePanel={jest.fn()} panel
    />,
  );
  const controls = StyleSheet.flatten(screen.getByTestId('chat-header-controls').props.style) as { flexWrap?: string };
  expect(controls.flexWrap).toBe('wrap');
  for (const name of ['History', 'New chat', 'Questions and activity (2)']) {
    const button = screen.getByRole('button', { name });
    const style = StyleSheet.flatten(button.props.style) as { width?: number; height?: number };
    expect([style.width, style.height]).toEqual([44, 44]);
    // No words drawn but the badge's count; native reads the name, and draws no tooltip.
    expect(within(button).queryByText(name)).toBeNull();
  }
  // The badge is hidden from screen readers, since the name says the count.
  expect(within(screen.getByRole('button', { name: 'Questions and activity (2)' })).getByText('2', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.queryByTestId('chat-tooltip')).toBeNull();
});
