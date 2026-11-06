import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { PlaceMap } from '../../../src/portal/places/PlaceMap';

// The confirm card's map on native: the image loads the signed URL from Google at 2:1 with a label naming the place,
// and nothing renders without a map or once the image fails.

const URL = 'https://maps.googleapis.com/maps/api/staticmap?center=place_id%3AChIJTestPlace0001&key=test-static-key&signature=yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=';
const LABEL = 'Map of the area around Lou’s Restaurant';

test('a map renders one labelled image of the signed URL, full width at 2:1', async () => {
  await render(<PlaceMap map={{ url: URL, width: 640, height: 320 }} label={LABEL} />);
  const image = screen.getByLabelText(LABEL);
  expect(image.props.source).toEqual({ uri: URL });
  expect(image.props.accessible).toBe(true);
  expect(StyleSheet.flatten(image.props.style)).toMatchObject({ width: '100%', aspectRatio: 2 });
  expect(image.props.resizeMode).toBe('cover');
});

test('null renders nothing', async () => {
  await render(<PlaceMap map={null} label={LABEL} />);
  expect(screen.queryByLabelText(LABEL)).toBeNull();
  expect(screen.toJSON()).toBeNull();
});

test('an image that fails to load leaves no empty box, and a new map shows again', async () => {
  const view = await render(<PlaceMap map={{ url: URL, width: 640, height: 320 }} label={LABEL} />);
  await fireEvent(screen.getByLabelText(LABEL), 'error', { nativeEvent: { error: 'HTTP 403' } });
  expect(screen.queryByLabelText(LABEL)).toBeNull();
  const next = URL.replace('ChIJTestPlace0001', 'ChIJTestPlace0002');
  await view.rerender(<PlaceMap map={{ url: next, width: 640, height: 320 }} label={LABEL} />);
  expect(screen.getByLabelText(LABEL).props.source).toEqual({ uri: next });
});
