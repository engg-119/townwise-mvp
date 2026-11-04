import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

import { Field } from '../src/ui';

test('Field uses fontSize 16', async () => {
  const view = await render(<Field label="Email" />);
  const input = view.container.queryAll((instance) => instance.type === 'TextInput')[0];
  const style = StyleSheet.flatten(input?.props.style) as { fontSize?: number };
  expect(style.fontSize).toBe(16);
});
