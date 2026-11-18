import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

// Whether the page can be seen: the app in the foreground on iOS and Android, the tab in view on web (react-native-web's
// AppState follows the document's visibility). The new chat page reads the list for Previous chats only while it is.

export function usePageVisible(): boolean {
  const [state, setState] = useState<AppStateStatus | null>(() => (AppState.currentState as AppStateStatus | null | undefined) ?? null);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', setState);
    return () => { subscription.remove(); };
  }, []);
  return state !== 'background';
}
