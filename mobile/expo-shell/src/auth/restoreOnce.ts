import type { Auth } from './auth';

const started = new WeakSet<Auth>();

// One restore per auth object, so remounting the gate (or a StrictMode double effect) never restores twice.
export function restoreOnce(auth: Auth): void {
  if (started.has(auth)) return;
  started.add(auth);
  void auth.restore();
}
