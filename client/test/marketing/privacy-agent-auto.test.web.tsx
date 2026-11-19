import { cleanup, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import Privacy from '../../app/(marketing)/privacy';
import { fakeAuth } from '../helpers/fakes';

// D59 (openspec change auto-apply-agent-reads, design decision 14): the privacy page says which files TownwiseAI reads
// with no press and which it never does, what it may add, that it never changes or deletes what exists, that each change
// has Undo and a log, and that Anthropic receives the files it reads on its own; the old “never unless you ask” line is
// gone. Marked [CONFIRM] until the owner approves it.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;

afterEach(() => { cleanup(); });

function renderPrivacy(): string {
  const auth = fakeAuth({ status: 'signedOut' });
  window.history.replaceState(null, '', '/privacy');
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext({
          _layout: () => <AuthProvider auth={auth}><RootStack /></AuthProvider>,
          '(marketing)/_layout': MarketingLayout,
          '(marketing)/privacy': Privacy,
        })}
        location="/privacy"
      />
    </Head.Provider>,
  );
  return screen.getByRole('main').textContent;
}

test('says stored files other than sales exports are read on their own unless an org admin turns it off or the file’s box was unchecked', () => {
  const text = renderPrivacy();
  expect(text).toContain('Files you let TownwiseAI read. Unless an org admin turns it off on the TownwiseAI page, TownwiseAI reads each file added to Your data on its own once Townwise has stored it, except a sales export Townwise read into days, a calendar export, and any file whose box under Add a file was unchecked.');
  expect(text).toContain('TownwiseAI saves what it’s sure of to your account');
  expect(text).toContain('An event it isn’t sure of, or one that disagrees with a note or rule your team made, waits for someone on your team to add or dismiss it.');
  expect(text).not.toContain('Townwise never sends a file you add to an AI model unless you ask');
  expect(text).not.toContain('is off until you choose it');
});

test('a Changes TownwiseAI makes item says what it may add, that it changes and deletes nothing, Undo, the log and what is kept', () => {
  renderPrivacy();
  const items = screen.getAllByRole('listitem');
  const changes = items.find((item) => item.textContent.startsWith('Changes TownwiseAI makes.'));
  if (changes === undefined) throw new Error('no Changes TownwiseAI makes item');
  for (const words of [
    'a note, a summary on Your data, or sales days you didn’t have',
    'It never changes or deletes anything that exists.',
    'Each change shows in TownwiseAI’s activity with Undo',
    'listed on the TownwiseAI page’s log of its changes',
    'so a change someone undid is never made again',
  ]) expect(changes.textContent).toContain(words);
  // It follows the weekly suggestions, the other thing TownwiseAI does with nobody pressing anything.
  const weekly = items.findIndex((item) => item.textContent.startsWith('TownwiseAI’s weekly suggestions.'));
  expect(items.indexOf(changes)).toBe(weekly + 1);
});

test('the Anthropic item names the files TownwiseAI reads on its own beside the weekly suggestions', () => {
  renderPrivacy();
  const anthropic = within(screen.getByRole('region', { name: 'Who else sees it' })).getAllByRole('listitem').find((item) => item.textContent.startsWith('Anthropic,'));
  expect(anthropic?.textContent).toContain('Apart from TownwiseAI’s weekly suggestions and the files it reads on its own');
  expect(anthropic?.textContent).toContain('When TownwiseAI reads a file, on its own or because you let it, the whole file is sent to it');
  expect(anthropic?.textContent).toContain('TownwiseAI never reads a sales file Townwise read into days unless you let it read one.');
});
