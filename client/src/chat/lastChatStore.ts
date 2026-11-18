import * as SecureStore from 'expo-secure-store';

import type { LastChatStore } from './lastChat';

// lastChat.ts's memory on iOS and Android: the device's secure store, which the app already uses for its session.
// Every call settles, null or nothing on any failure. The app closing is not the page closing: only the page's own
// unmount writes here (onPageLeave never fires).

export const lastChatStore: LastChatStore = {
  async read(key) {
    try {
      return (await SecureStore.getItemAsync(key)) ?? null;
    } catch {
      return null;
    }
  },
  async write(key, value) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // Not kept: coming back opens a new chat.
    }
  },
  async remove(key) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Nothing to forget, or it can't be: a kept one still expires after 5 minutes.
    }
  },
};

/** Web closes a page without unmounting it (lastChatStore.web.ts); native has no such case, so this never calls back. */
export const onPageLeave: (listener: () => void) => () => void = () => () => undefined;
