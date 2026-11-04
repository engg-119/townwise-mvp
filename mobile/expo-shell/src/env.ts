import type { Env } from './config';

function defined(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return value;
}

const apiUrl = defined(process.env.EXPO_PUBLIC_API_URL);
const webUrl = defined(process.env.EXPO_PUBLIC_WEB_URL);
const googleWebClientId = defined(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID);
const googleIosClientId = defined(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);

export const env: Env = {
  ...(apiUrl === undefined ? {} : { EXPO_PUBLIC_API_URL: apiUrl }),
  ...(webUrl === undefined ? {} : { EXPO_PUBLIC_WEB_URL: webUrl }),
  ...(googleWebClientId === undefined ? {} : { EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: googleWebClientId }),
  ...(googleIosClientId === undefined ? {} : { EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: googleIosClientId }),
};
