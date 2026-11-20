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

test('the Town research item says what research sends, including Google’s name and address for the restaurant and up to 8 nearby places, and what it never sends', () => {
  const text = pageText();
  expect(text).toContain('Town research. Unless an org admin turns it off for your organization on a location’s Town tab, TownwiseAI researches each location’s town, and the restaurant and the places near it, on the web: once a week, with nobody using TownwiseAI,');
  expect(text).toContain('For the town, Anthropic receives the town’s name, state and time zone, today’s date, the public calendar Townwise already has for it (titles, dates and official calendar links) and what earlier research found there.');
  // TOWNWISE_RESEARCH_PLACES_TO_AI=true in api/production.env (decided 2026-11-19 by the owner: allowed).
  expect(text).toContain('To research the restaurant and its competition, Anthropic also receives the name and address of the place you picked for the location, as Google’s listing gives them, the names, kinds and websites Google gives for up to 8 restaurants, bars and cafes within 1,500 meters of it, and what earlier research found for that location;');
  expect(text).toContain('when Google has no listing for the place or doesn’t answer, research skips the restaurant and its competition that time. Research never sends your organization’s name, the name you gave the location in Townwise, your sales or other figures, notes, business rules, calendars or their events’ titles, files, TownwiseAI conversations, changes your team made to researched events, or anyone’s name or email address.');
  expect(text).not.toContain('anything else Google sends about your place');
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
  expect(text).toContain('taken from those pages; for an event of one of the nearby places Google listed, it also keeps Google’s id for that place.');
  expect(text).toContain('Events are kept until 400 days after they end');
  expect(text).toContain('Our logs and audit record hold only counts and codes, never a search, a web address, a title or a name.');
});

test('the Anthropic item lists research among what runs with nobody using TownwiseAI', () => {
  const text = pageText();
  expect(text).toContain('Apart from TownwiseAI’s weekly suggestions, town research (which runs every week with nobody using TownwiseAI; see Town research, under Your organization and team) and, where it works on its own,');
  expect(text).toContain('its calendar, the events town research found, as your team edited them, and who is likely in town');
  expect(text).toContain('For town research, Anthropic receives the town’s public calendar and, for each location, its restaurant’s name and address as Google’s listing gives them and the names, kinds and websites Google gives for up to 8 restaurants, bars and cafes near it; never your sales, notes, your calendars’ event titles or anyone’s name.');
});

test('the weekly suggestions wording no longer says the location’s name is never sent, since researched events can name the restaurant', () => {
  const text = pageText();
  expect(text).not.toContain('or your organization’s or location’s name');
  expect(text).toContain('a calendar’s name, or your organization’s name. The weekly reading doesn’t send your location’s name either, though an event town research found can name your restaurant or another public business.');
  expect(text).toContain('That calendar includes up to 60 events town research found that Townwise rates as likely, as your team edited them, never the ones it hid; a suggestion that rests on one always waits for someone on your team, even where TownwiseAI works on its own (see Town research).');
});

test('the Google item names Nearby Search for the Competition card and for each location’s research, what goes to Anthropic, and only place ids kept', () => {
  const text = pageText();
  expect(text).toContain('When someone opens a location’s Competition card on the Town tab, our server asks Google for the restaurants, bars and cafes within 1,500 meters of the location’s picked place (Google’s Nearby Search)');
  expect(text).toContain('Each time a location is researched (see Town research), our server also asks Google for the name and address of the location’s picked place and for the restaurants, bars and cafes within 1,500 meters of it with their websites, and sends Anthropic the place’s name and address and the names, kinds and websites of up to 8 of them. Townwise keeps nothing Google answers about those places apart from Google’s ids for those places.');
  expect(text).not.toContain('sends none of it to Anthropic');
});

test('TownwiseAI’s changes cover correcting a researched event, and a web page still never changes the forecast', () => {
  const text = pageText();
  expect(text).toContain('When you ask it to, TownwiseAI also corrects, hides or restores an event town research found, for that location only (see Town research); in a conversation where it read the web or a file, it shows the change for you to apply with one tap instead.');
  expect(text).toContain('apart from using a calendar file’s labels for forecasts when every label on it is TownwiseAI’s own and correcting a researched event you asked it to.');
  expect(text).toContain('A web page never changes your forecast');
  expect(text).toContain('Last updated November 19, 2026.');
});
