import { cleanup, render, screen } from '@testing-library/react';

import { PlaceMap } from '../../../src/portal/places/PlaceMap';

// The confirm card's map on web, through react-native-web: one labelled image whose only content is Google's own
// image (so nothing covers Google's logo), loaded from the signed URL, at 2:1; nothing at all without a map.

const URL = 'https://maps.googleapis.com/maps/api/staticmap?center=place_id%3AChIJTestPlace0001&key=test-static-key&signature=yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=';
const LABEL = 'Map of the area around Lou’s Restaurant';

afterEach(() => { cleanup(); });

test('a map renders one labelled image of the signed URL at 2:1, with nothing laid over it', () => {
  const { container } = render(<PlaceMap map={{ url: URL, width: 640, height: 320 }} label={LABEL} />);
  // react-native-web draws the picture as a background layer of a role="img" element (whose children are
  // presentational, so the label is read once) and keeps a transparent <img> of the same URL for the context menu.
  const [image, picture] = screen.getAllByRole('img', { name: LABEL });
  expect(container.children).toHaveLength(1);
  expect(container.firstElementChild).toBe(image);
  expect(image?.getAttribute('role')).toBe('img');
  expect(picture?.tagName).toBe('IMG');
  expect(picture?.getAttribute('src')).toBe(URL);
  if (image === undefined) throw new Error('no image');
  expect(window.getComputedStyle(image).aspectRatio).toBe('2');
  expect(window.getComputedStyle(image).width).toBe('100%');
  // Nothing but the picture inside: no text, control or overlay over Google's logo.
  expect(image.textContent).toBe('');
  expect(image.querySelectorAll('button, a, [role="button"], [role="text"], span')).toHaveLength(0);
  expect(image.children).toHaveLength(2);
});

test('null renders nothing', () => {
  const { container } = render(<PlaceMap map={null} label={LABEL} />);
  expect(container.childElementCount).toBe(0);
});
