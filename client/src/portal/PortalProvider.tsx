import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';

import type { ApiClient, RequestOptions, StreamOptions } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { fetchMe, fetchOrg } from './api';
import { needsRecheck } from './errors';
import { formatTime } from './format';
import type { LoadState } from './hooks';
import type { MeResponse, OrgResponse } from './schemas';

// The portal's shared state, one per signed-in session (app/(gate)/(app)/_layout.tsx):
// - GET /api/me, read on mount (after restore and after sign-in) and again after join, decline, a request,
//   End view-as and Check again (spec 4.3);
// - `api`: the kit client, except that the access errors of 4.3 re-read GET /api/me so the layout routes again;
// - the organization (GET /api/org), loaded once and shared by the frame, Locations and the location pages, and
//   cleared whenever the access is read again;
// - one-time page notices that survive a redirect ("You joined …", "View-as ended at …").

export interface Notice {
  text: string;
  /** A link after the text, ended with a full stop: "Not your team? Leave {org}." */
  link?: { label: string; href: string };
}

interface StoredNotice {
  notice: Notice;
  /** The paths the notice may show on; null for any page. */
  where: RegExp | null;
  /** The path it first showed on. It shows there only, once. */
  shownAt: string | null;
}

export interface Portal {
  me: MeResponse;
  /** The API client for portal pages: re-reads GET /api/me on 403 no_access, forbidden, staff gates and 409 view_as_active. */
  api: ApiClient;
  /** Uses an answer that carries the access (join, decline, request, End view-as); the layout routes on it. */
  applyMe: (me: MeResponse) => void;
  /** Reads GET /api/me again and applies it. Rejects when it can't be read; the current access stays. */
  refreshMe: () => Promise<MeResponse>;
  notice: StoredNotice | null;
  /** Shows `notice` once, on the first page that matches `where` (any page when left out). */
  showNotice: (notice: Notice, where?: RegExp) => void;
  markNoticeShown: (path: string) => void;
  org: LoadState<OrgResponse> | null;
  /** Starts loading the organization unless it is loading or loaded. */
  ensureOrg: () => void;
  reloadOrg: () => void;
}

type MeLoad = { status: 'loading' } | { status: 'failed'; error: unknown } | { status: 'ready'; me: MeResponse };

interface PortalContextValue {
  meState: MeLoad;
  retry: () => void;
  portal: Portal | null;
  /** Forgets a notice once the person has moved on from the page it showed on. */
  leftPath: (path: string) => void;
}

const PortalContext = createContext<PortalContextValue | null>(null);

const CONSOLE_PATHS = /^\/admin(\/|$)/;

export function PortalProvider(props: { children: React.ReactNode }): React.JSX.Element {
  const auth = useAuth();
  const [meState, setMeState] = useState<MeLoad>({ status: 'loading' });
  const [notice, setNotice] = useState<StoredNotice | null>(null);
  const [org, setOrg] = useState<LoadState<OrgResponse> | null>(null);
  const current = useRef<MeResponse | null>(null);
  const reading = useRef<Promise<MeResponse> | null>(null);
  const orgTicket = useRef(0);
  const orgStarted = useRef(false);

  const applyMe = useCallback((next: MeResponse) => {
    const previous = current.current;
    current.current = next;
    // Spec 4.3: cached organization data is cleared before the client routes again.
    orgTicket.current += 1;
    orgStarted.current = false;
    setOrg(null);
    // Spec 15.5: when view-as ends (End, expiry, or the target changing organization), staff land on /admin
    // with the time it ended.
    if (previous?.viewAs != null && next.viewAs === null && next.access.state === 'staff') {
      const now = new Date();
      const endsAt = new Date(previous.viewAs.endsAt);
      const at = endsAt.getTime() < now.getTime() ? endsAt : now;
      setNotice({ notice: { text: `View-as ended at ${formatTime(at)}.` }, where: CONSOLE_PATHS, shownAt: null });
    }
    setMeState({ status: 'ready', me: next });
  }, []);

  const refreshMe = useCallback((): Promise<MeResponse> => {
    reading.current ??= fetchMe(auth.api)
      .then((next) => { applyMe(next); return next; })
      .finally(() => { reading.current = null; });
    return reading.current;
  }, [auth, applyMe]);

  const firstRead = useCallback(() => {
    refreshMe().catch((error: unknown) => {
      if (current.current === null) setMeState({ status: 'failed', error });
    });
  }, [refreshMe]);

  useEffect(() => { firstRead(); }, [firstRead]);

  const retry = useCallback(() => {
    setMeState({ status: 'loading' });
    firstRead();
  }, [firstRead]);

  const api = useMemo<ApiClient>(() => {
    const base = auth.api;
    function watch<T>(promise: Promise<T>): Promise<T> {
      return promise.catch((error: unknown) => {
        if (needsRecheck(error)) refreshMe().catch(() => undefined);
        throw error;
      });
    }
    return {
      request: (path: `/${string}`, opts?: RequestOptions) => watch(base.request(path, opts)),
      json: <T,>(path: `/${string}`, schema: z.ZodType<T>, opts?: RequestOptions) => watch(base.json(path, schema, opts)),
      stream: (path: `/${string}`, opts: StreamOptions) => watch(base.stream(path, opts)),
      logout: () => base.logout(),
    };
  }, [auth, refreshMe]);

  const ensureOrg = useCallback(() => {
    if (orgStarted.current) return;
    orgStarted.current = true;
    const ticket = orgTicket.current;
    setOrg({ status: 'loading' });
    fetchOrg(api).then(
      (data) => { if (ticket === orgTicket.current) setOrg({ status: 'ready', data }); },
      (error: unknown) => { if (ticket === orgTicket.current) setOrg({ status: 'failed', error }); },
    );
  }, [api]);

  const reloadOrg = useCallback(() => {
    orgTicket.current += 1;
    orgStarted.current = false;
    ensureOrg();
  }, [ensureOrg]);

  const showNotice = useCallback((next: Notice, where?: RegExp) => {
    setNotice({ notice: next, where: where ?? null, shownAt: null });
  }, []);

  const markNoticeShown = useCallback((path: string) => {
    setNotice((stored) => (stored?.shownAt !== null ? stored : { ...stored, shownAt: path }));
  }, []);

  const leftPath = useCallback((path: string) => {
    setNotice((stored) => (stored?.shownAt != null && stored.shownAt !== path ? null : stored));
  }, []);

  const me = meState.status === 'ready' ? meState.me : null;
  const portal = useMemo<Portal | null>(() => (me === null ? null : {
    me, api, applyMe, refreshMe, notice, showNotice, markNoticeShown, org, ensureOrg, reloadOrg,
  }), [me, api, applyMe, refreshMe, notice, showNotice, markNoticeShown, org, ensureOrg, reloadOrg]);

  const value = useMemo<PortalContextValue>(() => ({ meState, retry, portal, leftPath }), [meState, retry, portal, leftPath]);
  return <PortalContext.Provider value={value}>{props.children}</PortalContext.Provider>;
}

/** The provider's raw state, for the portal layout. */
export function usePortalContext(): PortalContextValue {
  const value = useContext(PortalContext);
  if (value === null) throw new Error('usePortalContext must be used within PortalProvider');
  return value;
}

/** The portal, for any page under the portal layout (GET /api/me has answered). */
export function usePortal(): Portal {
  const portal = useContext(PortalContext)?.portal ?? null;
  if (portal === null) throw new Error('usePortal must be used under the portal layout, after GET /api/me');
  return portal;
}

/** The portal, or null outside it (a screen rendered on its own in a test, or before GET /api/me answers). */
export function useOptionalPortal(): Portal | null {
  return useContext(PortalContext)?.portal ?? null;
}

/** The organization (GET /api/org), shared by every page that shows it. */
export function useOrg(): { state: LoadState<OrgResponse>; reload: () => void } {
  const { org, ensureOrg, reloadOrg } = usePortal();
  useEffect(() => { if (org === null) ensureOrg(); }, [org, ensureOrg]);
  return { state: org ?? { status: 'loading' }, reload: reloadOrg };
}

/** Under view-as every write control renders disabled, with this one line (spec 15.5). */
export function useReadOnly(): { readOnly: boolean; line: string } {
  const viewAs = useOptionalPortal()?.me.viewAs ?? null;
  return viewAs === null
    ? { readOnly: false, line: '' }
    : { readOnly: true, line: `Read-only while viewing as ${viewAs.target.email}.` };
}
