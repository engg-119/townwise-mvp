import { env } from '../src/env';
import { filterIncomingUrl } from '../src/auth/magicLink';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return filterIncomingUrl(path, env.EXPO_PUBLIC_WEB_URL);
}
