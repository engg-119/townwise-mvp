// Web: the browser's fetch streams the body already. Called through globalThis so it is never invoked with
// another `this` (an "Illegal invocation" in browsers).
export function streamFetch(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init);
}
