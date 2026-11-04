import { VIEW_HEIGHT, VIEW_WIDTH, type BBox, type Point } from './geometry';

// The map camera: a scale k and a translation (tx, ty) applied to the world group, never to the viewBox.
// cameraFor uses the rule that built map.towns[].zoom in townwise-home.json, so it reproduces those values
// exactly (test/marketing/camera.test.ts): the town's bbox fills at most half the view each way, the scale
// stays between 1 and 24, and the bbox center goes to the view center. k rounds to 0.01 and tx, ty to 0.1.

export interface Camera {
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

export const MAX_SCALE = 24;
const FILL = 0.5;

export const REGION: Camera = { k: 1, tx: 0, ty: 0 };

export function cameraFor(bbox: BBox | null): Camera {
  if (bbox === null) return REGION;
  const [x0, y0, x1, y1] = bbox;
  const k = Math.max(1, Math.min((FILL * VIEW_WIDTH) / (x1 - x0), (FILL * VIEW_HEIGHT) / (y1 - y0), MAX_SCALE));
  return {
    k: Math.round(k * 100) / 100,
    tx: Math.round((VIEW_WIDTH / 2 - k * ((x0 + x1) / 2)) * 10) / 10,
    ty: Math.round((VIEW_HEIGHT / 2 - k * ((y0 + y1) / 2)) * 10) / 10,
  };
}

// The world group's CSS transform, for transform-origin 0 0 and transform-box view-box.
export function cameraTransform({ k, tx, ty }: Camera): string {
  return `translate(${tx}px, ${ty}px) scale(${k})`;
}

// Where a map point lands under the camera, in viewBox units (the HTML overlay places markers with it).
export function cameraPoint({ k, tx, ty }: Camera, [x, y]: Point): Point {
  return [k * x + tx, k * y + ty];
}
