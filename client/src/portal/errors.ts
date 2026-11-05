import { ApiError } from '../api/client';

// The shared error copy (spec 15.7, the SignIn artboard's strings word for word) and the errors that make the
// client re-read GET /api/me (spec 4.3). Page-specific codes (409 location_name_taken and the rest) are each
// page's own copy: check them with hasCode before falling back to errorCopy.

export const COPY = {
  network: 'Can’t reach Townwise. Check your connection and try again.',
  unavailable: 'Townwise isn’t responding. Try again in a minute.',
  server: 'Something went wrong on our side. Try again in a minute.',
  request: 'Something went wrong with that request. Reload the page and try again.',
  signedOut: 'Your session ended. Sign in again to continue.',
  signOutFailed: 'Couldn’t sign out. Check your connection and try again.',
} as const;

const RECHECK: Readonly<Record<number, readonly string[]>> = {
  403: ['no_access', 'forbidden', 'staff_setup_required', 'staff_reauth_required'],
  409: ['view_as_active'],
};

/** True for the answers after which the client re-reads GET /api/me and routes again. */
export function needsRecheck(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.kind !== 'http' || error.code === null) return false;
  return RECHECK[error.status]?.includes(error.code) === true;
}

export function hasCode(error: unknown, status: number, code: string): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === status && error.code === code;
}

export function tooManyAttempts(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) return 'Too many attempts. Try again in a few minutes.';
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Try again in ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

/** The one line to show for an error no page handles itself. */
export function errorCopy(error: unknown): string {
  if (!(error instanceof ApiError)) return COPY.server;
  switch (error.kind) {
    case 'network':
    case 'timeout':
    case 'storage':
      return COPY.network;
    case 'signed_out':
      return COPY.signedOut;
    case 'invalid_response':
      return COPY.server;
    case 'aborted':
      return COPY.request;
    case 'http':
      if (error.status === 429) return tooManyAttempts(error.retryAfterSeconds);
      if (error.status === 503) return COPY.unavailable;
      if (error.status >= 500) return COPY.server;
      return COPY.request;
  }
}
