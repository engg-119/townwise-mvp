import { Platform } from 'react-native';

// ARIA attributes that react-native-web renders on the DOM element but React Native's types do not declare.
// On native they are dropped; native screen readers get the same facts from accessibilityState and
// accessibilityHint where the component sets them.

export interface WebAria {
  'aria-current'?: 'page' | 'true' | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | undefined;
  'aria-required'?: boolean | undefined;
  'aria-level'?: number | undefined;
  'aria-readonly'?: boolean | undefined;
  'aria-pressed'?: boolean | undefined;
  'aria-expanded'?: boolean | undefined;
  'aria-controls'?: string | undefined;
}

/** Spread into a React Native element: `<View {...webAria({ 'aria-current': 'page' })} />`. */
export function webAria(props: WebAria): object {
  if (Platform.OS !== 'web') return {};
  const defined = Object.entries(props).filter(([, value]) => value !== undefined && value !== '');
  return Object.fromEntries(defined);
}

/** Joins the ids a control is described by, skipping the empty ones. */
export function ids(...values: (string | null | undefined | false)[]): string | undefined {
  const joined = values.filter((value): value is string => typeof value === 'string' && value !== '').join(' ');
  return joined === '' ? undefined : joined;
}
