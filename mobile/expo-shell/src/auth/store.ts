import type { ApiError } from '../api/client';

export interface User { id: string; email: string }

export type AuthState =
  | { status: 'restoring' }
  | { status: 'unreachable'; error: ApiError }
  | { status: 'signedOut'; notice?: string }
  | { status: 'mfaRequired'; mfaToken: string }
  | { status: 'signedIn'; user: User };

export interface AuthStore {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  set(next: AuthState): void;
}

export function createAuthStore(initial?: AuthState): AuthStore {
  let state: AuthState = initial ?? { status: 'restoring' };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

export function routeFor(state: AuthState): '/' | '/sign-in' | '/totp' | null {
  switch (state.status) {
    case 'signedIn': return '/';
    case 'mfaRequired': return '/totp';
    case 'signedOut': return '/sign-in';
    case 'restoring':
    case 'unreachable':
      return null;
  }
}
