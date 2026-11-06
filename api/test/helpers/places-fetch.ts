// A scripted stand-in for Google Places (New) behind the PlacesClient port (src/places/google.ts): a fake fetch that
// records every request and answers each from the next step of its script. Tests never call Google.
import type { AddressComponent } from '../../src/places/google.ts';

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  /** The parsed JSON body, or undefined without one. */
  readonly body: unknown;
  readonly signal: AbortSignal | null;
}

export type Step =
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'text'; status: number; body: string }
  /** Rejects the way undici does when the connection fails. */
  | { kind: 'network' }
  /** Never answers; rejects with the signal's reason once it aborts, as fetch does. */
  | { kind: 'hang' };

export interface FakePlaces {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly calls: RecordedCall[];
  script(...steps: Step[]): void;
  reset(): void;
}

function headersOf(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  return headers;
}

export function fakePlaces(): FakePlaces {
  const calls: RecordedCall[] = [];
  let steps: Step[] = [];
  const fetchFn = (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url, method: init.method ?? 'GET', headers: headersOf(init),
      body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined, signal: init.signal ?? null,
    });
    const step = steps.shift();
    if (step === undefined) return Promise.reject(new Error('unscripted Google call'));
    switch (step.kind) {
      case 'json':
        return Promise.resolve(Response.json(step.body, { status: step.status ?? 200 }));
      case 'text':
        return Promise.resolve(new Response(step.body, { status: step.status, headers: { 'content-type': 'text/html' } }));
      case 'network':
        return Promise.reject(new TypeError('fetch failed'));
      case 'hang':
        return new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (signal === null || signal === undefined) return;
          signal.addEventListener('abort', () => { reject(signal.reason as Error); }, { once: true });
        });
    }
  };
  return {
    fetch: fetchFn,
    calls,
    script: (...next) => { steps.push(...next); },
    reset: () => {
      calls.length = 0;
      steps = [];
    },
  };
}

/** One placePrediction, shaped like Google's (text, structuredFormat with matches, types). */
export function placePrediction(placeId: string, main: string, secondary?: string): unknown {
  return {
    placePrediction: {
      place: `places/${placeId}`,
      placeId,
      text: { text: secondary === undefined ? main : `${main}, ${secondary}`, matches: [{ endOffset: 3 }] },
      structuredFormat: {
        mainText: { text: main, matches: [{ endOffset: 3 }] },
        ...(secondary === undefined ? {} : { secondaryText: { text: secondary } }),
      },
      types: ['restaurant', 'food', 'point_of_interest', 'establishment'],
    },
  };
}

export function queryPrediction(text: string): unknown {
  return { queryPrediction: { text: { text, matches: [{ endOffset: 3 }] }, structuredFormat: { mainText: { text } } } };
}

export function component(longText: string, shortText: string, ...types: string[]): AddressComponent {
  return { longText, shortText, types };
}

/** A US street address's components; each town-naming part is left out unless given. */
export function usAddress(opts: {
  locality?: string; postalTown?: string; sublocality?: string; adminLevel3?: string; state?: string; country?: string;
}): AddressComponent[] {
  return [
    component('8', '8', 'street_number'),
    component('South Main Street', 'S Main St', 'route'),
    ...(opts.sublocality === undefined ? [] : [component(opts.sublocality, opts.sublocality, 'sublocality_level_1', 'sublocality', 'political')]),
    ...(opts.locality === undefined ? [] : [component(opts.locality, opts.locality, 'locality', 'political')]),
    ...(opts.postalTown === undefined ? [] : [component(opts.postalTown, opts.postalTown, 'postal_town')]),
    ...(opts.adminLevel3 === undefined ? [] : [component(opts.adminLevel3, opts.adminLevel3, 'administrative_area_level_3', 'political')]),
    component('Grafton County', 'Grafton County', 'administrative_area_level_2', 'political'),
    ...(opts.state === undefined ? [] : [component(opts.state, opts.state, 'administrative_area_level_1', 'political')]),
    component(opts.country === 'US' || opts.country === undefined ? 'United States' : opts.country, opts.country ?? 'US', 'country', 'political'),
    component('03755', '03755', 'postal_code'),
  ];
}

/** Google's Place Details answer for the details field mask. */
export function placeDetails(id: string, formattedAddress: string, addressComponents: AddressComponent[]): unknown {
  return {
    id, formattedAddress,
    addressComponents: addressComponents.map((part) => ({ ...part, languageCode: 'en' })),
  };
}
