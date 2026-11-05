import { createContext, useContext, useSyncExternalStore } from 'react';

import type { AuthState } from './store';
import type { Auth } from './auth';

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider(props: { auth: Auth; children: React.ReactNode }): React.JSX.Element {
  return <AuthContext.Provider value={props.auth}>{props.children}</AuthContext.Provider>;
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (auth === null) throw new Error('useAuth must be used within AuthProvider');
  return auth;
}

export function useAuthState(): AuthState {
  const auth = useAuth();
  return useSyncExternalStore(
    (listener) => auth.store.subscribe(listener),
    () => auth.store.getState(),
    () => auth.store.getState(),
  );
}
