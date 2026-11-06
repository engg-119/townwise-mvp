// Reading time left (spec 11A, Progress and ETA), computed when a view is built from what was measured; nothing is
// guessed. Null means "Estimating": no measurement yet, too early to trust one, or above six hours.

const ETA_MIN_ELAPSED_MS = 3000;
const ETA_MIN_SHARE = 0.05;
const ETA_MAX_SECONDS = 6 * 60 * 60;
/** An import queued this long and not yet claimed is "Waiting for a turn". */
export const WAITING_FOR_TURN_MS = 10_000;

/** Rounds up to a multiple of 5 seconds. */
export function ceil5(seconds: number): number {
  return Math.ceil(seconds / 5) * 5;
}

function clamped(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const rounded = ceil5(seconds);
  return rounded > ETA_MAX_SECONDS ? null : rounded;
}

/** A reading file's time left, from its own progress in the current phase. */
export function readingEta(progress: { done: number; total: number | null; phaseStartedAt: Date } | null, now: Date): number | null {
  const total = progress?.total ?? null;
  if (progress === null || total === null || total <= 0) return null;
  const elapsed = now.getTime() - progress.phaseStartedAt.getTime();
  if (elapsed < ETA_MIN_ELAPSED_MS || progress.done / total < ETA_MIN_SHARE || progress.done <= 0) return null;
  const rate = progress.done / elapsed;
  return clamped((total - progress.done) / rate / 1000);
}

export interface EtaFile {
  readonly id: string;
  readonly status: string;
  readonly sizeBytes: number;
  readonly progress: { done: number; total: number | null; phaseStartedAt: Date } | null;
}

export interface ImportEta {
  /** Per file id, for queued and reading files; others are absent (null). */
  readonly files: ReadonlyMap<string, number | null>;
  /** 1-based among the import's queued files. */
  readonly positions: ReadonlyMap<string, number>;
  readonly etaSeconds: number | null;
  readonly waitingForTurn: boolean;
}

/**
 * Every file's time left in one import, in upload order. A queued file waits for the reading file and every queued
 * file before it, at the speed this import's finished files were read (`bytesRead / msRead`). The first file of an
 * import always says "Estimating" until it finishes.
 */
export function importEta(
  input: {
    status: string; startedAt: Date | null; claimedAt: Date | null; bytesRead: number; msRead: number;
    files: readonly EtaFile[];
  },
  now: Date,
): ImportEta {
  const waitingForTurn = input.status === 'queued' && input.startedAt !== null && input.claimedAt === null
    && now.getTime() - input.startedAt.getTime() >= WAITING_FOR_TURN_MS;
  const etas = new Map<string, number | null>();
  const positions = new Map<string, number>();
  const reading = input.files.find((file) => file.status === 'reading');
  const readingLeft = reading === undefined ? 0 : readingEta(reading.progress, now);
  if (reading !== undefined) etas.set(reading.id, readingLeft);
  const throughput = input.msRead > 0 && input.bytesRead > 0 ? input.bytesRead / input.msRead : null;
  let queuedBytes = 0;
  let lastQueued: number | null | undefined;
  for (const file of input.files) {
    if (file.status !== 'queued') continue;
    positions.set(file.id, positions.size + 1);
    queuedBytes += file.sizeBytes;
    const eta = waitingForTurn || throughput === null || readingLeft === null ? null : clamped(readingLeft + queuedBytes / throughput / 1000);
    etas.set(file.id, eta);
    lastQueued = eta;
  }
  let etaSeconds: number | null = null;
  if (lastQueued !== undefined) etaSeconds = lastQueued;
  else if (reading !== undefined) etaSeconds = readingLeft;
  return { files: etas, positions, etaSeconds, waitingForTurn };
}
