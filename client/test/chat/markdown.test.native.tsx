import { render, screen } from '@testing-library/react-native';

import { Markdown } from '../../src/chat/markdown/Markdown';

// The Markdown renderer on native: no sideways page scroll, so a table sits in a horizontal ScrollView.

it('renders a table in a horizontal ScrollView and a list with its markers', async () => {
  await render(<Markdown source={'- one\n- two\n\n3. three\n\n| Day | Note |\n|---|---|\n| Mon | Closed |'} />);
  expect(screen.getAllByText('•')).toHaveLength(2);
  expect(screen.getByText('3.')).toBeTruthy();
  expect(screen.getByText('Closed')).toBeTruthy();
  expect(JSON.stringify(screen.toJSON())).toContain('"horizontal":true');
});
