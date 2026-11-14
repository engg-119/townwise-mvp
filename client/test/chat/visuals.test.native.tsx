import { fireEvent, render, screen } from '@testing-library/react-native';

import { visualSchema } from '../../src/chat/visuals/schema';
import { VisualView } from '../../src/chat/visuals/Visual';
import { daily, down12, forecastOnly, storedBeforeMid, weekdays } from './visuals-fixtures';

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

test('a range with no sales yet keeps the forecast in the summary and the numbers, with no chart', async () => {
  await render(<VisualView visual={forecastOnly} />);
  expect(screen.getByText('Guests and forecast, Nov 16 to Nov 22, 2026')).toBeTruthy();
  expect(screen.getByText('See the chart at townwise.tech.')).toBeTruthy();
  expect(screen.getByText(/^No sales yet for these days\. .*1 day closed and 1 day booked for a private event\.$/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: /Show the numbers/ }));
  for (const label of ['Forecast low', 'Forecast middle', 'Forecast high', 'Closed', 'Booked', '180']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
});

test('a daily visual stored before the forecast’s middle was sent still shows its summary and numbers', async () => {
  await render(<VisualView visual={visualSchema.parse(storedBeforeMid)} />);
  expect(screen.getByText(/^2 days with data\./)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: /Show the numbers/ }));
  expect(screen.queryByText('Forecast middle')).toBeNull();
  expect(screen.getAllByText('Forecast low').length).toBeGreaterThan(0);
});
