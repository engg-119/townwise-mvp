import { act, cleanup, render, screen } from '@testing-library/react';

import { InTown } from '../../../src/portal/home/InTown';
import { ACCESS, meOf } from '../../helpers/portal';
import { analyticsFake } from '../analytics/fakes';
import { LOCATION_ID, NOVEMBER, PEOPLE_PATH } from '../estimates/fakes';
import { portalWrapper } from '../files/harness';

// Who's in town on web at phone width (spec 15.7: one column, no horizontal scroll): each row puts its date over its
// words instead of beside them, and the block reads the same words at every width. Synthetic data only.

let width = 375;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

function setWidth(next: number): void {
  width = next;
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  setWidth(375);
});

function rowOf(text: string): HTMLElement {
  const row = screen.getByText(text).parentElement;
  if (row === null) throw new Error(`no row for ${text}`);
  return row;
}

test('at phone width a row stacks its date over its words; wide, they sit side by side; the words never change', async () => {
  const Wrapper = portalWrapper(analyticsFake({ [PEOPLE_PATH]: NOVEMBER }), meOf(ACCESS.member));
  render(<Wrapper><InTown today="2026-11-05" townId="hanover-nh" locationId={LOCATION_ID} /></Wrapper>);
  await screen.findByText('Nov 20 to 25');
  expect(window.getComputedStyle(rowOf('Nov 20 to 25')).flexDirection).toBe('column');
  const phone = document.body.textContent;
  setWidth(1280);
  expect(window.getComputedStyle(rowOf('Nov 20 to 25')).flexDirection).toBe('row');
  expect(document.body.textContent).toBe(phone);
});
