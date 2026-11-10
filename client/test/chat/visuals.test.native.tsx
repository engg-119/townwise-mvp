import { fireEvent, render, screen } from '@testing-library/react-native';

import { VisualView } from '../../src/chat/visuals/Visual';
import { daily, down12, weekdays } from './visuals-fixtures';

test('draws no chart on native and says where it is; the summary and numbers stay', async () => {
  await render(<VisualView visual={daily} />);
  expect(screen.getByText('See the chart at townwise.tech.')).toBeTruthy();
  expect(screen.getByText(/4 days with data\./)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: /Show the numbers/ }));
  expect(screen.getByText('Fri, Oct 2, 2026')).toBeTruthy();
});

test('a breakdown says where its chart is, and metrics draw cards', async () => {
  await render(<VisualView visual={weekdays} />);
  expect(screen.getByText('See the chart at townwise.tech.')).toBeTruthy();
  await render(<VisualView visual={down12} />);
  expect(screen.getByText('−12%')).toBeTruthy();
});
