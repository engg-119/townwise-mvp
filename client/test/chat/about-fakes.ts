import type { z } from 'zod';

import { ApiError, type RequestOptions } from '../../src/api/client';
import type { EstimatesAbout, ForecastRun } from '../../src/portal/estimates/api';
import type { FakeChatApi } from '../helpers/chat';
import { ABOUT } from '../portal/estimates/fakes';

// F10: GET .../estimates/about for the Agent page's tests, served by the tuning chat's fake: the model card with no
// forecast (the estimates fakes' ABOUT), or with a published run. Every figure is made up.

export const ABOUT_PATH = '/api/org/locations/l1/estimates/about';

export const NO_FORECAST: EstimatesAbout = {
  ...ABOUT,
  location: { name: 'Main Street Bar', town: { name: 'Hanover', state: 'NH' } },
};

export const RUN: ForecastRun = {
  id: '000000000000000000000010', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v9', label: 'Townwise demand model v9' },
  trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-10-21', madeAt: '2026-11-01', frozen: true,
  interval: { level: 0.8, widened: true },
  backtest: { from: '2026-01-05', to: '2026-03-15', weeks: 10, weeklyTypicalErrorPct: 9.5, weeksOver20Pct: 1 },
};

export const PUBLISHED: EstimatesAbout = { ...NO_FORECAST, forecast: { run: RUN, live: null } };

export type AboutFake = FakeChatApi & { about: unknown; aboutLoads: number };

/** Makes `chat` answer GET .../estimates/about with `answer` (an ApiError rejects). Calling it again changes the answer. */
export function serveAbout(chat: FakeChatApi, answer: unknown = NO_FORECAST): AboutFake {
  const served = chat as AboutFake;
  if (!Object.hasOwn(served, 'about')) {
    const json = chat.json.bind(chat);
    served.aboutLoads = 0;
    served.json = <T,>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions): Promise<T> => {
      if (path !== ABOUT_PATH || (opts?.method ?? 'GET') !== 'GET') return json(path, schema, opts);
      served.aboutLoads += 1;
      const value = served.about;
      return value instanceof ApiError ? Promise.reject(value) : Promise.resolve(schema.parse(value));
    };
  }
  served.about = answer;
  return served;
}
