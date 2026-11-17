import { z } from 'zod';

import type { ApiClient } from '../../api/client';

// The forecast lab in the staff console (forecast lab design call 8): an organization's calibrations and forecasts
// switch, starting a calibration for a location, and switching forecasts on or off. A calibration is read as the
// server words it: its status, the gate's words and a summary of percentages and counts, never a guest figure.

function id(value: string): string {
  return encodeURIComponent(value);
}

export const CALIBRATION_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;

export const calibrationSchema = z.object({
  id: z.string(),
  locationId: z.string(),
  status: z.enum(CALIBRATION_STATUSES),
  failure: z.string().nullable(),
  failureWords: z.string().nullable(),
  /** TownwiseAI's chat, the staff console, a file someone let TownwiseAI read (D34), or the weekly refresh (D42). */
  via: z.enum(['chat', 'console', 'file', 'scheduled']),
  /** `system` is the weekly refresh, which no person started (D42). */
  requestedByRole: z.enum(['org_admin', 'superadmin', 'system']),
  regimeStart: z.string().nullable(),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  runId: z.string().nullable(),
  chargedUsd: z.number(),
  gate: z.object({ published: z.boolean(), reason: z.string(), words: z.string().nullable() }).nullable(),
  summary: z.object({
    weeks: z.number(),
    weeklyWapePct: z.number(),
    championWeeklyWapePct: z.number().nullable(),
    coverage: z.object({ inside: z.number(), weeks: z.number() }),
    weekdayBiasPct: z.number(),
    championWeekdayBiasPct: z.number().nullable(),
  }).nullable(),
});
export type Calibration = z.infer<typeof calibrationSchema>;

/** `at` null with `on` true is an organization nobody switched: on by default (D42). */
const forecastsSchema = z.object({ on: z.boolean(), at: z.string().nullable() });
export type ForecastsState = z.infer<typeof forecastsSchema>;

/** The weekly refresh (D42): whether it runs at all (the lab and the deploy switch), and the staff pause for every organization. */
const scheduleSchema = z.object({ running: z.boolean(), paused: z.object({ at: z.string(), email: z.string() }).nullable() });
export type ScheduleState = z.infer<typeof scheduleSchema>;

/** A location's latest week row: the Monday, what the weekly refresh did, and the calibration it started. */
const weekSchema = z.object({ locationId: z.string(), week: z.string(), outcome: z.string(), calibrationId: z.string().nullable() });
export type WeekRow = z.infer<typeof weekSchema>;

// `schedule` and `weeks` are optional, so the console still reads an API from before D42's worker.
const listSchema = z.object({
  forecasts: forecastsSchema, schedule: scheduleSchema.optional(), weeks: z.array(weekSchema).optional(), calibrations: z.array(calibrationSchema),
});
export type CalibrationList = z.infer<typeof listSchema>;
const startSchema = z.object({ calibration: calibrationSchema });
const switchSchema = z.object({ forecasts: forecastsSchema });
const scheduleAnswer = z.object({ schedule: scheduleSchema });

/** The forecasts switch and the newest calibrations of the organization. */
export function fetchCalibrations(api: ApiClient, orgId: string): Promise<CalibrationList> {
  return api.json(`/api/admin/orgs/${id(orgId)}/calibrations`, listSchema);
}

/**
 * 201 the queued calibration. 409 calibration_in_progress, not_enough_history or chat_budget_exhausted, 429
 * calibrations_rate_limited, 400 invalid_regime_start and 503 lab_unavailable or lab_start_failed carry the words.
 */
export async function startCalibration(api: ApiClient, orgId: string, locationId: string, regimeStart: string | null): Promise<Calibration> {
  const path = `/api/admin/orgs/${id(orgId)}/locations/${id(locationId)}/calibrations` as const;
  return (await api.json(path, startSchema, { method: 'POST', body: regimeStart === null ? {} : { regimeStart } })).calibration;
}

/** Switching on carries the staff member’s word that the owner agreed. */
export async function switchForecasts(api: ApiClient, orgId: string, on: boolean): Promise<ForecastsState> {
  const path = `/api/admin/orgs/${id(orgId)}/forecasts-switch` as const;
  return (await api.json(path, switchSchema, { method: 'POST', body: on ? { on: true, ownerAgreed: true } : { on: false } })).forecasts;
}

/** Pauses or resumes every scheduled start of the weekly refresh, for all organizations (D42). */
export async function setSchedulePaused(api: ApiClient, paused: boolean): Promise<ScheduleState> {
  return (await api.json('/api/admin/forecast-schedule', scheduleAnswer, { method: 'POST', body: { paused } })).schedule;
}
