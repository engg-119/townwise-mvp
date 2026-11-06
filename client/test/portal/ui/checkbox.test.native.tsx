import { render, screen, userEvent } from '@testing-library/react-native';

import { Checkbox } from '../../../src/portal/ui';

// The shared checkbox on native (home.md 4.2): the checkbox role with its checked and disabled state, a press
// toggles it, and a disabled box ignores presses.

test('a press asks for the other state; the role and state say what it is', async () => {
  const onChange = jest.fn();
  await render(<Checkbox label="Closed days" checked={false} onChange={onChange} />);
  const box = screen.getByRole('checkbox', { name: 'Closed days' });
  expect(box.props.accessibilityState).toMatchObject({ checked: false, disabled: false });
  await userEvent.setup().press(box);
  expect(onChange).toHaveBeenCalledWith(true);
});

test('checked, it asks to uncheck; disabled, it ignores presses', async () => {
  const onChange = jest.fn();
  const view = await render(<Checkbox label="2026" checked onChange={onChange} />);
  const user = userEvent.setup();
  await user.press(screen.getByRole('checkbox', { name: '2026' }));
  expect(onChange).toHaveBeenLastCalledWith(false);
  onChange.mockClear();
  await view.rerender(<Checkbox label="2026" checked disabled onChange={onChange} />);
  const box = screen.getByRole('checkbox', { name: '2026' });
  expect(box.props.accessibilityState).toMatchObject({ checked: true, disabled: true });
  await user.press(box);
  expect(onChange).not.toHaveBeenCalled();
});
