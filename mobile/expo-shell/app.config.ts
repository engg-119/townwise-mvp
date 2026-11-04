import type { ConfigContext, ExpoConfig } from 'expo/config';

function present(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return value;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const webUrl = present(process.env.EXPO_PUBLIC_WEB_URL);
  const iosClientId = present(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);
  const plugins: NonNullable<ExpoConfig['plugins']> = ['expo-router', 'expo-secure-store'];
  if (iosClientId !== undefined) {
    const prefix = iosClientId.replace(/\.apps\.googleusercontent\.com$/, '');
    plugins.push([
      '@react-native-google-signin/google-signin',
      { iosUrlScheme: `com.googleusercontent.apps.${prefix}` },
    ]);
  }

  const ios: NonNullable<ExpoConfig['ios']> = { ...config.ios, bundleIdentifier: 'tech.townwise.app' };
  const android: NonNullable<ExpoConfig['android']> = { ...config.android, package: 'tech.townwise.app' };
  if (webUrl !== undefined) {
    const host = new URL(webUrl).host;
    ios.associatedDomains = [`applinks:${host}`];
    android.intentFilters = [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host, pathPrefix: '/auth/magic' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ];
  }

  return {
    ...config,
    name: 'Townwise',
    slug: 'townwise',
    scheme: 'townwise',
    ios,
    android,
    web: { ...config.web, output: 'single', bundler: 'metro' },
    plugins,
  };
};
