import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ATTACH_FILES, useComposerFiles } from '../../src/chat/ui/ComposerFiles.web';

// The composer's + (Attach files) is the round arrow of ChatButton: a 44px circle whose hover fill stays inside the
// composer's rounded box, and a disabled + (view-as) shows no hover.

jest.mock('../../src/portal/PortalProvider', () => ({ usePortal: () => ({ api: {} }) }));
jest.mock('../../src/portal/files/api', () => ({ listFiles: () => Promise.resolve([]) }));
jest.mock('../../src/portal/files/uploadQueue', () => ({
  useUploadQueue: () => ({ items: [], add: () => [], cancel: () => undefined, forget: () => undefined, filesUnavailable: false }),
}));
jest.mock('../../src/portal/hooks', () => ({ useLoad: () => ({ state: { status: 'ready', data: true } }) }));

afterEach(cleanup);

function Harness(props: { readOnlyId: string | null }): React.JSX.Element {
  return <>{useComposerFiles('loc', props.readOnlyId, () => undefined).button}</>;
}

function plus(): HTMLElement {
  return screen.getByRole('button', { name: ATTACH_FILES });
}

test('the + is a 44px circle with a plus icon; hover fills it, and leaving clears it', () => {
  render(<Harness readOnlyId={null} />);
  const style = getComputedStyle(plus());
  expect(style.getPropertyValue('border-top-left-radius')).toBe('22px');
  expect(style.getPropertyValue('width')).toBe('44px');
  expect(plus().querySelector('svg')).not.toBeNull();
  const rest = getComputedStyle(plus()).backgroundColor;
  fireEvent.mouseEnter(plus());
  expect(getComputedStyle(plus()).backgroundColor).not.toBe(rest);
  fireEvent.mouseLeave(plus());
  expect(getComputedStyle(plus()).backgroundColor).toBe(rest);
});

test('a disabled + shows no hover', () => {
  render(<Harness readOnlyId="note" />);
  expect(plus().getAttribute('aria-disabled')).toBe('true');
  const rest = getComputedStyle(plus()).backgroundColor;
  fireEvent.mouseEnter(plus());
  expect(getComputedStyle(plus()).backgroundColor).toBe(rest);
});
