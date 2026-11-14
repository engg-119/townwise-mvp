import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ADD_FILE, useComposerFiles } from '../../src/chat/ui/ComposerFiles.web';

// The composer's + : hover turns its own border white (it cannot reach past the composer's rounded box), and a
// disabled + (view-as) shows no hover.

jest.mock('../../src/portal/PortalProvider', () => ({ usePortal: () => ({ api: {} }) }));
jest.mock('../../src/portal/files/api', () => ({ listFiles: () => Promise.resolve([]) }));
jest.mock('../../src/portal/files/uploadQueue', () => ({
  useUploadQueue: () => ({ items: [], add: () => undefined, cancel: () => undefined, forget: () => undefined, filesUnavailable: false }),
}));
jest.mock('../../src/portal/hooks', () => ({ useLoad: () => ({ state: { status: 'ready', data: true } }) }));

afterEach(cleanup);

function Harness(props: { readOnlyId: string | null }): React.JSX.Element {
  return <>{useComposerFiles('loc', props.readOnlyId).button}</>;
}

function border(): string {
  return getComputedStyle(screen.getByRole('button', { name: ADD_FILE })).borderTopColor;
}

test('hover whitens the + border, and leaving clears it', () => {
  render(<Harness readOnlyId={null} />);
  const rest = border();
  fireEvent.mouseEnter(screen.getByRole('button', { name: ADD_FILE }));
  expect(border()).not.toBe(rest);
  fireEvent.mouseLeave(screen.getByRole('button', { name: ADD_FILE }));
  expect(border()).toBe(rest);
});

test('a disabled + shows no hover', () => {
  render(<Harness readOnlyId="note" />);
  const rest = border();
  fireEvent.mouseEnter(screen.getByRole('button', { name: ADD_FILE }));
  expect(border()).toBe(rest);
});
