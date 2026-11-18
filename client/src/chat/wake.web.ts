// When a TownwiseAI turn's dropped stream is read again at once on the web (resumable-chat-turns, design decision 6):
// the network coming back, and the tab becoming visible again (a phone's browser suspends a hidden tab's connections).

/** Calls `wake` on `online` and on `visibilitychange` to visible; the returned function stops listening. */
export function onWake(wake: () => void): () => void {
  const visible = (): void => {
    if (document.visibilityState === 'visible') wake();
  };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', visible);
  return () => {
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', visible);
  };
}
