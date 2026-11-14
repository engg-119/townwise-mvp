import { Pressable, StyleSheet, type PressableStateCallbackType } from 'react-native';

import { theme } from '../../theme';
import { setThemeMode, useThemeMode } from './themeMode';

// The light and dark switch: before Sign out in every portal bar (TopBar), and before Sign in in the public header
// (src/marketing/MarketingShell.web.tsx). A 44px square button named for what it does, “Switch to light mode” or
// “Switch to dark mode”, that draws where it goes: a sun in dark mode, a moon in light. Hover fills the square with
// `raised`, inside its own edges; focus takes the page's ring (the portal's in PortalStyles.web.tsx, the public pages'
// in styles.web.ts, both 2px of mint). The icons are Lucide's sun and moon (ISC license, lucide.dev), stroked in
// currentColor, so their color is a CSS `color` and follows the palette. A press flips the mode shown (the system's
// setting until the first pick) on every page, and the browser keeps the pick (themeMode.ts).

// react-native-web reports hover in the press state; React Native's types do not declare it.
function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

function Sun(): React.JSX.Element {
  return (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  );
}

function Moon(): React.JSX.Element {
  return <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />;
}

export function ThemeToggle(): React.JSX.Element {
  const next = useThemeMode() === 'light' ? 'dark' : 'light';
  return (
    <Pressable
      role="button"
      accessibilityLabel={`Switch to ${next} mode`}
      onPress={() => { setThemeMode(next); }}
      style={(state) => [styles.box, hovered(state) ? styles.hover : null]}
    >
      <svg
        width={20}
        height={20}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={{ display: 'block', color: theme.color.white }}
      >
        {next === 'light' ? <Sun /> : <Moon />}
      </svg>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  hover: { backgroundColor: theme.color.raised },
});
