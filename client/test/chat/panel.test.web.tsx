import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Pressable, Text } from 'react-native';

import { PanelSheet } from '../../src/chat/ui/PanelSheet';

let width = 600;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

afterEach(() => {
  cleanup();
  width = 600;
});

function Harness(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const opener = useRef(null);
  return (
    <>
      <Pressable ref={opener} role="button" aria-label="Open panel" onPress={() => { setOpen(true); }}>
        <Text>Open panel</Text>
      </Pressable>
      <PanelSheet open={open} onClose={() => { setOpen(false); }} openerRef={opener}>
        <Text>Panel body</Text>
      </PanelSheet>
    </>
  );
}

it('the sheet focuses its heading, traps focus, and Escape returns focus to the opener', () => {
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open panel' });
  opener.focus();
  act(() => { fireEvent.click(opener); });
  const heading = screen.getByRole('heading', { name: 'Questions and activity' });
  expect(screen.getByText('Panel body')).toBeTruthy();
  expect(document.activeElement).toBe(heading);
  const close = screen.getByRole('button', { name: 'Close' });
  close.focus();
  fireEvent.keyDown(close, { key: 'Tab' });
  expect(document.activeElement).not.toBe(opener);
  // A whole press: react-native-web's Modal closes the top-most modal on Escape's keyup. The sheet renders between
  // the two, as in a browser.
  act(() => { fireEvent.keyDown(close, { key: 'Escape' }); });
  act(() => { fireEvent.keyUp(document.activeElement ?? document.body, { key: 'Escape' }); });
  expect(screen.queryByRole('heading', { name: 'Questions and activity' })).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it('Close shuts the sheet and returns focus to the opener', () => {
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open panel' });
  act(() => { fireEvent.click(opener); });
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Close' })); });
  expect(screen.queryByText('Panel body')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it('renders nothing from 1024px, where the panel is a column', () => {
  width = 1280;
  act(() => { window.dispatchEvent(new Event('resize')); });
  render(<Harness />);
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Open panel' })); });
  expect(screen.queryByText('Panel body')).toBeNull();
});
