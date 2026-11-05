const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface MagicLink { token: string; email: string }

export function parseMagicFragment(hash: string | undefined): MagicLink | null {
  if (hash === undefined) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '' || raw.includes('?')) return null;
  let token: string | null = null;
  let email: string | null = null;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'token' && token === null) token = value;
    if (key === 'email' && email === null) {
      try {
        email = decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }
  if (token === null || email === null || email === '' || !TOKEN.test(token)) return null;
  return { token, email };
}

export function filterIncomingUrl(url: string, webUrl: string | undefined): string {
  const hash = url.indexOf('#');
  if (hash === -1) return url;
  const magic = webUrl === undefined ? null : `${webUrl.replace(/\/+$/, '')}/auth/magic`;
  return url.slice(0, hash) === magic ? url : url.slice(0, hash);
}
