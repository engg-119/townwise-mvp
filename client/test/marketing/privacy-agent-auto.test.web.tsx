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
// gone; (slice 3) what the weekly suggestions and the sales history save on its own, and a calendar change bringing the
// weekly reading forward. Marked [CONFIRM] until the owner approves it.

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

test('says files are read on their own only where TownwiseAI works on its own, with the box checked, and that a sales export added under Add a file is sent', () => {
  const text = renderPrivacy();
  expect(text).toContain('Files you let TownwiseAI read. Townwise sends a file you add to an AI model only when you let it. Where TownwiseAI works on its own for your organization (an org admin can turn it off on the TownwiseAI page), the box under Add a file, and the one under your sales history’s drop, starts checked, and TownwiseAI reads each file that finishes uploading with its box checked once Townwise has stored it, except a sales export Townwise read into days and a calendar export.');
  expect(text).toContain('A sales export added under Add a file isn’t read into days, so it is sent whole too unless you uncheck the box.');
  // Production keeps it off until the owner approves: the page still says the box is off there.
  expect(text).toContain('Where it doesn’t work on its own, the box is off until you choose it.');
  expect(text).toContain('TownwiseAI saves what it’s sure of to your account');
  expect(text).toContain('An event it isn’t sure of, or one that disagrees with a note or rule your team made, waits for someone on your team to add or dismiss it.');
  expect(text).not.toContain('Townwise never sends a file you add to an AI model unless you ask');
  expect(text).not.toContain('Unless an org admin turns it off on the TownwiseAI page, TownwiseAI reads');
});

test('the two retention sentences agree: the reason for a change stays in the log after the read is undone', () => {
  const text = renderPrivacy();
  expect(text).toContain('What Claude found is kept with the file until you undo the read or the file’s original is deleted, except TownwiseAI’s short reason for each change it saved, which stays in the log of its changes');
  expect(text).toContain('even once the change is undone or the file deleted');
});

test('a Changes TownwiseAI makes item says what it may add, that it changes and deletes nothing, Undo, the log and what is kept', () => {
  renderPrivacy();
  const items = screen.getAllByRole('listitem');
  const changes = items.find((item) => item.textContent.startsWith('Changes TownwiseAI makes.'));
  if (changes === undefined) throw new Error('no Changes TownwiseAI makes item');
  for (const words of [
    'a note, a summary on Your data, or sales days you didn’t have',
    'It never changes or deletes anything that exists, apart from using a calendar file’s labels for forecasts when every label on it is TownwiseAI’s own and correcting a researched event you asked it to.',
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
  expect(anthropic?.textContent).toContain('Apart from TownwiseAI’s weekly suggestions, town research (which runs every week with nobody using TownwiseAI; see Town research, under Your organization and team) and, where it works on its own, the files and pasted text it reads on its own');
  expect(anthropic?.textContent).toContain('When TownwiseAI reads a file, on its own or because you let it, the whole file is sent to it');
  expect(anthropic?.textContent).toContain('TownwiseAI never reads a sales file Townwise read into days unless you let it read one.');
});

test('slice 3: the weekly suggestions it is sure of, sales history rules and the weekly reading brought forward', () => {
  renderPrivacy();
  const items = screen.getAllByRole('listitem');
  const weekly = items.find((item) => item.textContent.startsWith('TownwiseAI’s weekly suggestions.'));
  for (const words of [
    'A suggestion changes nothing until an org admin accepts it, which saves it as that admin’s note or rule, except where TownwiseAI works on its own for your organization',
    'at most 2 business rules a week for each location',
    'brings that location’s weekly reading forward, at most once a day',
  ]) expect(weekly?.textContent).toContain(words);
  const changes = items.find((item) => item.textContent.startsWith('Changes TownwiseAI makes.'));
  expect(changes?.textContent).toContain('from its weekly suggestions (a note, or a closure rule, at most 2 business rules a week for each location)');
  expect(changes?.textContent).toContain('from your sales history (a business rule for a weekday with no sales on at least 9 in 10 of at least 8 counted weeks)');
  const anthropic = items.find((item) => item.textContent.startsWith('Anthropic,'));
  expect(anthropic?.textContent).toContain('once a week for each location (and, where TownwiseAI works on its own, sooner after a calendar change, at most once a day) Anthropic receives');
});

test('slice 4: a note saved from your own message, and pasted text read on its own', () => {
  const text = renderPrivacy();
  expect(text).toContain('Text you paste on Your data is read the same way when you save it with the box under Paste text checked; that box shows, checked, only where TownwiseAI works on its own.');
  const items = screen.getAllByRole('listitem');
  const conversations = items.find((item) => item.textContent.startsWith('TownwiseAI conversations.'));
  expect(conversations?.textContent).toContain('Where TownwiseAI works on its own, a note for a dated event you state plainly in your own message is saved to your notes for you, as yours, and its card shows Undo');
  // The Anthropic item's "only when you ask" is about a conversation: pasted text saved with its box checked is read on its own.
  const anthropic = items.find((item) => item.textContent.startsWith('Anthropic,'));
  expect(anthropic?.textContent).toContain('In a conversation, it reads a text item on Your data (text you pasted or a text file you added)');
  expect(anthropic?.textContent).not.toMatch(/\. It reads a text item on Your data/);
  const changes = items.find((item) => item.textContent.startsWith('Changes TownwiseAI makes.'));
  expect(changes?.textContent).toContain('from a file you add or text you paste on Your data (a note, a summary on Your data, or sales days you didn’t have), from a message you send it (a note for a dated event you state plainly in your own words)');
});
