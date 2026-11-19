import * as SecureStore from 'expo-secure-store';

import type { ViewStore } from './dataView';

// dataView.ts's memory on iOS and Android: the device's secure store, which the app already uses for its session. It
// can only be read later, so the page opens Organized and switches once the read lands. Every call settles: nothing
// kept on any failure.

export const viewStore: ViewStore = {
  readNow: () => null,
  async read(key) {
    try {
      return (await SecureStore.getItemAsync(key)) ?? null;
    } catch {
      return null;
    }
  },
  write(key, value) {
    void (async () => {
      try {
        await SecureStore.setItemAsync(key, value);
      } catch {
        // Not kept: the page opens Organized next time.
      }
    })();
  },
};
