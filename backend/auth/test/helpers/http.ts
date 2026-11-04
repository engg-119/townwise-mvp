export const WEB_ORIGIN = 'https://app.example.test';

export class CookieJar {
  private readonly values = new Map<string, string>();

  store(res: Response): void {
    const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      this.values.set(name, pair.slice(eq + 1).trim());
    }
  }

  header(): string | undefined {
    if (this.values.size === 0) return undefined;
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }
}

export function call(baseUrl: string, path: string, init?: {
  method?: string;
  json?: unknown;
  rawBody?: string;
  origin?: string;
  secFetchSite?: string;
  bearer?: string;
  jar?: CookieJar;
  cookieHeader?: string;
}): Promise<Response> {
  const headers = new Headers();
  if (init?.json !== undefined || init?.rawBody !== undefined) headers.set('content-type', 'application/json');
  if (init?.origin !== undefined) headers.set('origin', init.origin);
  if (init?.secFetchSite !== undefined) headers.set('sec-fetch-site', init.secFetchSite);
  if (init?.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`);
  const cookie = init?.cookieHeader ?? init?.jar?.header();
  if (cookie !== undefined) headers.set('cookie', cookie);
  const body = init?.rawBody ?? (init?.json !== undefined ? JSON.stringify(init.json) : undefined);
  return fetch(new URL(path, baseUrl), {
    method: init?.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    redirect: 'manual',
    ...(body !== undefined ? { body } : {}),
  });
}
