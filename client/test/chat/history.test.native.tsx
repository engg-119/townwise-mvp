import { cleanup, render, screen } from '@testing-library/react-native';
import { Dimensions, StyleSheet } from 'react-native';

import { ChatHeader } from '../../src/chat/ui/ChatHeader';

afterEach(async () => {
  await cleanup();
  jest.restoreAllMocks();
});

it('the header wraps on phones and every control is 44px tall', async () => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 390 });
  await render(
    <ChatHeader
      title="Earlier chat" conversations={[]} openId={null} streaming={false} readOnlyId={null} panelOpen={false} openQuestions={2}
      onOpen={jest.fn()} onNew={jest.fn()} onDelete={jest.fn()} onRename={jest.fn()} onTogglePanel={jest.fn()}
    />,
  );
  const controls = StyleSheet.flatten(screen.getByTestId('chat-header-controls').props.style) as { flexWrap?: string };
  expect(controls.flexWrap).toBe('wrap');
  for (const name of ['History', 'New chat', 'Questions and activity (2)']) {
    const style = StyleSheet.flatten(screen.getByRole('button', { name }).props.style) as { minHeight?: number };
    expect(style.minHeight).toBe(44);
  }
});
