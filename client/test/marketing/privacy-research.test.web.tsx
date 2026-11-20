import { cleanup, render, screen } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import Privacy from '../../app/(marketing)/privacy';
import { fakeAuth } from '../helpers/fakes';

// Spec D66 and Section 17, OpenSpec change town-research-agent, design decision 16 and task 8.1: what town research
// sends, what it never sends, and the sentences elsewhere on the page that research would otherwise make false.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

afterEach(() => { cleanup(); });

function pageText(): string {
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

test('the Town research item says what research sends, including the restaurant’s name and town, and what it never sends', () => {
  const text = pageText();
  expect(text).toContain('Town research. Unless an org admin turns it off for your organization on a location’s Town tab, TownwiseAI researches each location’s town, and the restaurant and the places near it, on the web: once a week, with nobody using TownwiseAI,');
  expect(text).toContain('For the town, Anthropic receives the town’s name, state and time zone, today’s date, the public calendar Townwise already has for it (titles, dates and official calendar links) and what earlier research found there.');
  expect(text).toContain('To research the restaurant and its competition, Anthropic also receives the location’s name as it appears in Townwise (which can be the name Google gave the place you picked, until you change it), with its town,');
  expect(text).toContain('when that name is only a town’s, such as Hanover, it receives your organization’s name before it instead. Research never sends your organization’s name otherwise, the address or anything else Google sends about your place or the places near it, your sales or other figures, notes, business rules, calendars, files, TownwiseAI conversations, changes your team made to researched events, or anyone’s name or email address.');
  expect(text).toContain('It is told never to research or report a private person.');
});

test('research’s searches go to Anthropic’s search provider and its pages are fetched by Anthropic', () => {
  const text = pageText();
  expect(text).toContain('Anthropic runs the searches TownwiseAI writes and sends them to its search provider, so a search can hold your restaurant’s name and town or the name of a nearby business; when research opens a page, Anthropic fetches it, and Townwise never opens the pages.');
  expect(text).toContain('Town research’s searches go to Anthropic’s search provider the same way, and the pages it opens are fetched by Anthropic (see Town research).');
});

test('the Town research item says what is kept, who can change it, what reads it and how long it stays', () => {
  const text = pageText();
  expect(text).toContain('A town’s events are shared by every Townwise restaurant in that town; a restaurant’s belong to its location.');
  expect(text).toContain('for that location only: it never changes another location’s or another organization’s calendar.');
  expect(text).toContain('but a suggestion that rests on one always waits for someone on your team to accept it.');
  expect(text).toContain('Research of a location uses your organization’s monthly TownwiseAI budget; research of a town is Townwise’s own cost.');
  expect(text).toContain('Events are kept until 400 days after they end');
  expect(text).toContain('Our logs and audit record hold only counts and codes, never a search, a web address, a title or a name.');
});

test('the Anthropic item lists research among what runs with nobody using TownwiseAI', () => {
  const text = pageText();
  expect(text).toContain('Apart from TownwiseAI’s weekly suggestions, town research (which runs every week with nobody using TownwiseAI; see Town research, under Your organization and team) and, where it works on its own,');
  expect(text).toContain('its calendar, the events town research found, as your team edited them, and who is likely in town');
});

test('the weekly suggestions wording no longer says the location’s name is never sent, since researched events can name the restaurant', () => {
  const text = pageText();
  expect(text).not.toContain('or your organization’s or location’s name');
  expect(text).toContain('a calendar’s name, or your organization’s name. The weekly reading doesn’t send your location’s name either, though an event town research found can name your restaurant or another public business.');
  expect(text).toContain('That calendar includes up to 60 events town research found that Townwise rates as likely, as your team edited them, never the ones it hid; a suggestion that rests on one always waits for someone on your team, even where TownwiseAI works on its own (see Town research).');
});

test('the Google item names Nearby Search around the location’s place for the Competition card, with nothing it answers kept or sent', () => {
  const text = pageText();
  expect(text).toContain('When someone opens a location’s Competition card on the Town tab, our server asks Google for the restaurants, bars and cafes within 1,500 meters of the location’s picked place (Google’s Nearby Search)');
  expect(text).toContain('Townwise keeps nothing Google answers about those places and sends none of it to Anthropic.');
  expect(text).toContain('When research finds nearby businesses’ events, our server also asks Google for the name of the location’s picked place, once a run, only to tell the restaurant’s own events from its competitors’; it keeps none of it and sends none of it to Anthropic.');
});

test('TownwiseAI’s changes cover correcting a researched event, and a web page still never changes the forecast', () => {
  const text = pageText();
  expect(text).toContain('When you ask it to, TownwiseAI also corrects, hides or restores an event town research found, for that location only (see Town research); in a conversation where it read the web or a file, it shows the change for you to apply with one tap instead.');
  expect(text).toContain('apart from using a calendar file’s labels for forecasts when every label on it is TownwiseAI’s own and correcting a researched event you asked it to.');
  expect(text).toContain('A web page never changes your forecast');
  expect(text).toContain('Last updated November 19, 2026.');
});
