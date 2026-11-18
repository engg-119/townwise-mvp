import { cleanup, render, screen } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { AuthProvider } from '../../src/auth/AuthProvider';
import { RootStack } from '../../app/_layout';
import MarketingLayout from '../../app/(marketing)/_layout';
import Privacy from '../../app/(marketing)/privacy';
import { fakeAuth } from '../helpers/fakes';

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

afterEach(() => { cleanup(); });

function forecastsParagraph(): string {
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
  const paragraph = [...screen.getByRole('region', { name: 'Your restaurant’s sales data' }).querySelectorAll('p')]
    .find((p) => p.textContent.startsWith('Forecasts.'));
  if (paragraph === undefined) throw new Error('no Forecasts paragraph');
  return paragraph.textContent;
}

// Autonomous forecasts (D42): forecasts publish by default and refit weekly, so the privacy page says so, and says which
// engine made a forecast, before the lab runs in production.
test('the Forecasts paragraph says forecasts are on by default, refit weekly from the location’s own days, and which engine made one', () => {
  const text = forecastsParagraph();
  expect(text).toContain('Forecasts are on for every organization; if you don’t want them, ask Townwise staff to turn yours off.');
  expect(text).toContain('Once a location’s sales history spans at least 230 days, Townwise forecasts its daily guests up to three months ahead and keeps that forecast current by itself');
  expect(text).toContain('each week, if anything has changed since the last fit, a background job on Townwise’s own servers refits it from that location’s own daily guest counts, the closures, private events and bookings in its notes and business rules, and the public town calendar. The job sees no other location’s days.');
  expect(text).toContain('Each forecast is made by Townwise’s trained demand model or, when the location’s history is too short for that model or a simpler baseline did better on its past weeks, by that baseline, built from its recent weeks and the town calendar; the app says which made it.');
  expect(text).toContain('A new forecast goes live only when it passes Townwise’s accuracy checks.');
  expect(text).toContain('it is not used for other restaurants, and it never trains AI models such as TownwiseAI’s.');
  expect(text).toContain('Townwise keeps the results (a range of guests per day, the dates the forecast learned from, the settings it was made with, and how accurate it has been) and not the fitted model.');
  expect(text).not.toContain('only once Townwise turns forecasts on');
});

test('the page carries its date, with nothing left saying staff must turn forecasts on first', () => {
  forecastsParagraph();
  const text = screen.getByRole('main').textContent;
  expect(text).toContain('Effective November 5, 2026. Last updated November 16, 2026.');
  expect(text).toContain('A forecast update it started keeps running, and goes live if it passes Townwise’s accuracy checks and your forecasts are on.');
  expect(text).not.toMatch(/turns forecasts on for you/);
});
