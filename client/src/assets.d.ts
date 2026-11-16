// A PNG imported by a static `import` (the source logos, src/portal/sources/logos.ts) is an image source: Metro's
// asset on native, its same-origin URL on web. expo-router declares the same through expo-env.d.ts, which is gitignored
// and outside the tsconfig, so this declaration is committed.
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';
  const value: ImageSourcePropType;
  export default value;
}
