import { describe, expect, it } from 'vitest';

import { ceil5, importEta, readingEta } from '../../src/files/eta.ts';

const start = new Date('2026-06-01T12:00:00.000Z');
const at = (seconds: number): Date => new Date(start.getTime() + seconds * 1000);

describe('reading ETA (spec 11A)', () => {
  it('rounds up to 5 seconds', () => {
    expect([0, 1, 5, 6].map(ceil5)).toEqual([0, 5, 5, 10]);
  });

  it('says Estimating before 3 seconds or 5 percent, and with no total', () => {
    expect(readingEta({ done: 50, total: 100, phaseStartedAt: start }, at(2))).toBeNull();
    expect(readingEta({ done: 4, total: 100, phaseStartedAt: start }, at(10))).toBeNull();
    expect(readingEta({ done: 4, total: null, phaseStartedAt: start }, at(10))).toBeNull();
    expect(readingEta(null, at(10))).toBeNull();
  });

  it('extrapolates the measured rate, and gives up above six hours', () => {
    expect(readingEta({ done: 25, total: 100, phaseStartedAt: start }, at(10))).toBe(30);
    expect(readingEta({ done: 6, total: 100, phaseStartedAt: start }, at(3600))).toBeNull();
  });

  const reading = { id: 'r', status: 'reading', sizeBytes: 100, progress: { done: 25, total: 100, phaseStartedAt: start } };
  const queued = (id: string, sizeBytes: number) => ({ id, status: 'queued', sizeBytes, progress: null });

  it('queued files wait for the reading file and those before them, at this import’s measured speed', () => {
    const eta = importEta({
      status: 'reading', startedAt: start, claimedAt: start, bytesRead: 1000, msRead: 1000,
      files: [{ id: 'd', status: 'read', sizeBytes: 1000, progress: null }, reading, queued('q1', 5000), queued('q2', 10_000)],
    }, at(10));
    expect(eta.files.get('r')).toBe(30);
    expect(eta.files.get('q1')).toBe(35);
    expect(eta.files.get('q2')).toBe(45);
    expect(eta.positions.get('q2')).toBe(2);
    expect(eta.etaSeconds).toBe(45);
    expect(eta.waitingForTurn).toBe(false);
  });

  it('says Estimating for queued files until one file of the import has finished', () => {
    const eta = importEta({ status: 'reading', startedAt: start, claimedAt: start, bytesRead: 0, msRead: 0, files: [reading, queued('q1', 5000)] }, at(10));
    expect(eta.files.get('q1')).toBeNull();
    expect(eta.etaSeconds).toBeNull();
  });

  it('is waiting for a turn when queued 10 seconds and not claimed, and then says Estimating', () => {
    const files = [queued('q1', 5000)];
    const waiting = importEta({ status: 'queued', startedAt: start, claimedAt: null, bytesRead: 1000, msRead: 1000, files }, at(10));
    expect(waiting.waitingForTurn).toBe(true);
    expect(waiting.files.get('q1')).toBeNull();
    expect(importEta({ status: 'queued', startedAt: start, claimedAt: null, bytesRead: 1000, msRead: 1000, files }, at(9)).waitingForTurn).toBe(false);
  });
});
