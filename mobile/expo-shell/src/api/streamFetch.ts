import { fetch as expoFetch } from 'expo/fetch';

// Native: expo/fetch resolves when the response headers arrive and exposes the body as a ReadableStream of
// Uint8Array chunks (`response.body.getReader()`), which React Native's own fetch does not. Aborting the
// signal after the headers errors the body stream, so a pending read rejects.
export function streamFetch(url: string, init: RequestInit): Promise<Response> {
  return expoFetch(url, init);
}
