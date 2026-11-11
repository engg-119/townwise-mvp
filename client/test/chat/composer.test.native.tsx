import { cleanup, render, screen, userEvent } from '@testing-library/react-native';
import { Dimensions } from 'react-native';

import { Composer, COMPOSER_LABEL, type ComposerProps } from '../../src/chat/ui/Composer';

afterEach(async () => {
  await cleanup();
  jest.restoreAllMocks();
});

function props(over: Partial<ComposerProps> = {}): ComposerProps {
  return {
    draft: '', onChange: jest.fn(), streaming: false, canSend: false, onSend: jest.fn(), onStop: jest.fn(),
    onStopAndSend: jest.fn(), help: 'Leave out guest names.', examples: ['How did last week go?'], readOnlyId: null,
    placement: 'dock', ...over,
  };
}

test('is one row on phones with the input named by the label and the help line under it', async () => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...Dimensions.get('window'), width: 390 });
  const onSend = jest.fn();
  await render(<Composer {...props({ draft: 'hi', canSend: true, onSend })} />);
  const field = screen.getByLabelText(COMPOSER_LABEL);
  expect(field.props.placeholder).toBe('Ask TownwiseAI');
  expect(screen.getByText('Leave out guest names.')).toBeTruthy();
  await userEvent.setup().press(screen.getByRole('button', { name: 'Send' }));
  expect(onSend).toHaveBeenCalledTimes(1);
});

test('Stop and send while a reply streams with text', async () => {
  const onStopAndSend = jest.fn();
  await render(<Composer {...props({ draft: 'next', canSend: true, streaming: true, onStopAndSend })} />);
  await userEvent.setup().press(screen.getByRole('button', { name: 'Stop and send' }));
  expect(onStopAndSend).toHaveBeenCalledTimes(1);
});
