import { cameraFor, cameraPoint, cameraTransform, MAX_SCALE, REGION } from '../../src/marketing/map/camera';
import { townShapes, VIEW_HEIGHT, VIEW_WIDTH, type BBox } from '../../src/marketing/map/geometry';

// map.towns[].zoom from townwise-home.json (generated 2026-11-03), copied exactly.
const ZOOM_IN_DATA: Record<string, { k: number; tx: number; ty: number }> = {
  'hanover-nh': { k: 24, tx: -14541, ty: -8891.4 },
  'amherst-ma': { k: 24, tx: -14076.5, ty: -11981.4 },
  'ithaca-ny': { k: 24, tx: -7336.6, ty: -11771.2 },
  'burlington-vt': { k: 24, tx: -12812.9, ty: -7140.2 },
  'middlebury-vt': { k: 24, tx: -12991.7, ty: -8253.7 },
  'state-college-pa': { k: 24, tx: -4880.2, ty: -15461.8 },
  'bar-harbor-me': { k: 24, tx: -20882.6, ty: -7089.6 },
  'stowe-vt': { k: 24, tx: -13643.2, ty: -7156.6 },
  'conway-nh': { k: 24, tx: -16352.4, ty: -8186.3 },
  'north-elba-ny': { k: 20.89, tx: -9995.7, ty: -6670 },
  'provincetown-ma': { k: 24, tx: -18005.9, ty: -12580.3 },
  'nantucket-ma': { k: 19.82, tx: -14934.1, ty: -11690.4 },
};

test('cameraFor(null) is the region view', () => {
  expect(cameraFor(null)).toEqual({ k: 1, tx: 0, ty: 0 });
  expect(cameraFor(null)).toBe(REGION);
  expect(cameraTransform(REGION)).toBe('translate(0px, 0px) scale(1)');
  expect(cameraPoint(REGION, [626.67, 388.54])).toEqual([626.67, 388.54]);
});

test('each town camera reproduces the zoom in the data', () => {
  expect(townShapes.map((town) => town.id)).toEqual(Object.keys(ZOOM_IN_DATA));
  for (const town of townShapes) expect([town.id, cameraFor(town.bbox)]).toEqual([town.id, ZOOM_IN_DATA[town.id]]);
});

test('each town camera centers its bbox inside the view and respects the scale limits', () => {
  for (const { id, bbox } of townShapes) {
    const camera = cameraFor(bbox);
    expect([id, camera.k >= 1 && camera.k <= MAX_SCALE]).toEqual([id, true]);
    const [left, top] = cameraPoint(camera, [bbox[0], bbox[1]]);
    const [right, bottom] = cameraPoint(camera, [bbox[2], bbox[3]]);
    // The bbox fills at most half the view each way (plus the rounding of k), so it sits well inside.
    expect([id, right - left <= VIEW_WIDTH / 2 + 1, bottom - top <= VIEW_HEIGHT / 2 + 1]).toEqual([id, true, true]);
    expect([id, left > 0, top > 0, right < VIEW_WIDTH, bottom < VIEW_HEIGHT]).toEqual([id, true, true, true, true]);
    // Its center lands on the view center, within what rounding k to 0.01 can move it.
    expect(Math.abs((left + right) / 2 - VIEW_WIDTH / 2)).toBeLessThan(2);
    expect(Math.abs((top + bottom) / 2 - VIEW_HEIGHT / 2)).toBeLessThan(2);
  }
});

test('the camera is pure and deterministic', () => {
  const bbox: BBox = Object.freeze([618.86, 383.27, 634.56, 393.93] as const);
  expect(cameraFor(bbox)).toEqual(cameraFor(bbox));
  expect(cameraFor(bbox)).not.toBe(cameraFor(bbox));
  expect(cameraTransform(cameraFor(bbox))).toBe('translate(-14541px, -8891.4px) scale(24)');
});

test('a bbox wider than half the view keeps the region scale', () => {
  expect(cameraFor([0, 0, VIEW_WIDTH, VIEW_HEIGHT]).k).toBe(1);
});
