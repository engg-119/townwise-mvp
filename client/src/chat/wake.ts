import { AppState } from 'react-native';

// When a TownwiseAI turn's dropped stream is read again at once (resumable-chat-turns, design decision 6). iOS and
// Android suspend a backgrounded app and drop its connections, so coming back to the foreground is the moment.

/** Calls `wake` each time the app comes back to the foreground; the returned function stops listening. */
export function onWake(wake: () => void): () => void {
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') wake();
  });
  return () => { subscription.remove(); };
}
