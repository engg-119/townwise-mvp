import { fileLineOf } from '../../src/chat/ui/ComposerFiles.web';
import type { QueuedUpload } from '../../src/portal/files/uploadQueue';

// The lines above the composer about files its + adds (D28): TownwiseAI reads only text files kept for reference,
// so a finished file says it can read it only when it is text.

function upload(state: QueuedUpload['state'], extra: Partial<QueuedUpload> = {}): QueuedUpload {
  return {
    key: 'u1', fileId: null, name: 'winter-hours.txt', sizeBytes: 25, state, sentBytes: 0, bytesPerSecond: null, secondsLeft: null,
    error: null, file: null, ...extra,
  };
}

test('says a finished text file is readable, and that any other kind is not', () => {
  expect(fileLineOf(upload('sending'))).toEqual({ key: 'u1', text: 'Adding winter-hours.txt to Your data', state: 'adding' });
  const text = upload('done', { file: { kind: 'text' } as QueuedUpload['file'] });
  expect(fileLineOf(text)).toEqual({ key: 'u1', text: 'winter-hours.txt is on Your data. TownwiseAI can read it.', state: 'added' });
  const pdf = upload('done', { name: 'menu.pdf', file: { kind: 'pdf' } as QueuedUpload['file'] });
  expect(fileLineOf(pdf).text).toBe('menu.pdf is on Your data. TownwiseAI reads only text files, so it can’t open this one.');
  expect(fileLineOf(upload('failed')).state).toBe('failed');
});
