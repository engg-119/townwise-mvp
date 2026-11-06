import { placeMapSchema } from '../../../src/portal/places/map';

// The confirm card's map schema: only a signed Maps Static URL on Google's origin parses, so the image can never be
// pointed anywhere else, and an unsigned URL is refused.

const PATH = 'https://maps.googleapis.com/maps/api/staticmap?center=place_id%3AChIJTestPlace0001&size=640x320&key=test-static-key';
const SIGNED = `${PATH}&signature=yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=`;

test('accepts a signed map at 640 by 320, and null', () => {
  expect(placeMapSchema.parse({ url: SIGNED, width: 640, height: 320 })).toEqual({ url: SIGNED, width: 640, height: 320 });
  expect(placeMapSchema.parse(null)).toBeNull();
  expect(placeMapSchema.default(null).parse(undefined)).toBeNull();
});

test('refuses an unsigned URL, another origin or path, a data URL, and another size', () => {
  const refused: unknown[] = [
    { url: PATH, width: 640, height: 320 },
    { url: `${SIGNED}&key=other`, width: 640, height: 320 },
    { url: `${PATH}&signature=short`, width: 640, height: 320 },
    { url: SIGNED.replace('https://maps.googleapis.com', 'https://maps.googleapis.com.example.test'), width: 640, height: 320 },
    { url: SIGNED.replace('https://', 'http://'), width: 640, height: 320 },
    { url: SIGNED.replace('/maps/api/staticmap', '/maps/api/streetview'), width: 640, height: 320 },
    { url: SIGNED.replace('https://maps.googleapis.com', 'https://example.test'), width: 640, height: 320 },
    { url: 'data:image/jpeg;base64,AAAA', width: 640, height: 320 },
    { url: `${PATH}${'x'.repeat(8200)}&signature=yLf7UY5VigCJ9Tc0GyjJzgV7Dbs=`, width: 640, height: 320 },
    { url: SIGNED, height: 320 },
    { url: SIGNED, width: 1280, height: 640 },
    { width: 640, height: 320 },
    undefined,
  ];
  for (const value of refused) expect({ value, ok: placeMapSchema.safeParse(value).success }).toEqual({ value, ok: false });
});
