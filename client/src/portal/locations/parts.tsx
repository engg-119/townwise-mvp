import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { usePortal } from '../PortalProvider';
import { locationHref } from '../routing';
import { webAria } from '../ui/aria';
import { Button, LinkButton } from '../ui/Button';
import { ErrorNotice, LoadingLine, Notice } from '../ui/feedback';
import { Small } from '../ui/text';

// Small pieces the location pages share (spec 15.6, 15.7, P11 to P16): the not-available state, the upload
// action (web only, D20), “Show the numbers”, and the pressed-button groups of the note form.

export const NATIVE_UPLOAD = 'Upload from a computer at townwise.tech.';

/** A read's failure: “This location isn’t available.” with a way back for a 404, the shared copy otherwise. */
export function LoadFailure(props: { error: unknown; onRetry: () => void }): React.JSX.Element {
  if (hasCode(props.error, 404, 'not_found')) {
    return (
      <View style={styles.missing}>
        <Notice text="This location isn’t available." />
        <LinkButton variant="link" href="/dashboard" label="Locations" />
      </View>
    );
  }
  return <ErrorNotice error={props.error} onRetry={props.onRetry} />;
}

export function Loading(props: { text: string; minHeight?: number }): React.JSX.Element {
  return <LoadingLine text={props.text} minHeight={props.minHeight ?? 320} />;
}

/**
 * “Upload sales history” (P13 is web only, D20): the page's primary or a text link on web; on native, the line
 * that says where to upload. Under view-as it is disabled in place, described by the read-only line.
 */
export function UploadAction(props: {
  locationId: string;
  variant: 'primary' | 'link';
  readOnlyId: string | null;
  nativeText?: string;
}): React.JSX.Element {
  if (Platform.OS !== 'web') return <Small>{props.nativeText ?? NATIVE_UPLOAD}</Small>;
  const label = 'Upload sales history';
  if (props.readOnlyId !== null) return <Button variant={props.variant} label={label} disabled describedBy={props.readOnlyId} />;
  return <LinkButton variant={props.variant} href={`${locationHref(props.locationId, 'sales')}/upload`} label={label} />;
}

/** “Show the numbers”: a toggle that opens the table under it (the design system's NumbersTable pattern). */
export function ShowNumbers(props: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.numbers}>
      <Pressable
        role="button"
        aria-expanded={open}
        onPress={() => { setOpen((value) => !value); }}
        style={styles.toggle}
      >
        <View style={styles.toggleBox}><Text style={styles.toggleGlyph}>{open ? '−' : '+'}</Text></View>
        <Text style={styles.toggleText}>Show the numbers</Text>
      </Pressable>
      {open ? props.children : null}
    </View>
  );
}

export interface ToggleOption<T extends string | number> { value: T; label: string; accessibilityLabel?: string }

/**
 * A row of pressed buttons (`.tgl`, spec P14 C6): `aria-pressed` on web, a checked state on native, and the mint
 * fill with the `on-mint` label when pressed. `multiple` lets any number be pressed.
 */
export function ToggleGroup<T extends string | number>(props: {
  label: string;
  helper?: string;
  options: readonly ToggleOption<T>[];
  isPressed: (value: T) => boolean;
  onPress: (value: T) => void;
  nativeID?: string;
}): React.JSX.Element {
  const helperId = props.nativeID === undefined ? undefined : `${props.nativeID}-help`;
  return (
    <View role="group" aria-label={props.label} style={styles.group}>
      <Text style={styles.legend}>{props.label}</Text>
      <View style={styles.toggles}>
        {props.options.map((option) => {
          const pressed = props.isPressed(option.value);
          return (
            <Pressable
              key={String(option.value)}
              role="button"
              accessibilityLabel={option.accessibilityLabel ?? option.label}
              accessibilityState={{ checked: pressed }}
              {...webAria({ 'aria-pressed': pressed, 'aria-describedby': helperId })}
              onPress={() => { props.onPress(option.value); }}
              style={[styles.tgl, pressed ? styles.tglOn : null]}
            >
              <Text style={[styles.tglText, pressed ? styles.tglTextOn : null]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {props.helper === undefined ? null : <Text nativeID={helperId} style={styles.help}>{props.helper}</Text>}
    </View>
  );
}

/**
 * After a write that changes what Locations shows for this location (its notes count, its sales history), the
 * shared organization (GET /api/org) is read again when this page closes. Not at once: reloading it reloads the
 * location's layout, which would close this page and its notice.
 */
export function useOrgRefreshOnLeave(): () => void {
  const { reloadOrg } = usePortal();
  const stale = useRef({ value: false });
  useEffect(() => {
    const flag = stale.current;
    return () => {
      if (!flag.value) return;
      flag.value = false;
      reloadOrg();
    };
  }, [reloadOrg]);
  return useCallback(() => { stale.current.value = true; }, []);
}

const c = theme.color;

const styles = StyleSheet.create({
  missing: { gap: theme.space[4], alignItems: 'flex-start' },
  numbers: { gap: theme.space[2] },
  toggle: { flexDirection: 'row', alignItems: 'center', columnGap: 8, minHeight: 44, alignSelf: 'flex-start' },
  toggleBox: { width: 16, height: 16, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  toggleGlyph: { ...theme.type.mono, lineHeight: 14, color: c.text2 },
  toggleText: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  group: { gap: theme.space[2], minWidth: 0 },
  legend: { ...theme.type.ui, color: c.white },
  toggles: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
  tgl: {
    minHeight: 44, minWidth: 44, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1,
    borderColor: c.line, backgroundColor: 'transparent',
  },
  tglOn: { backgroundColor: c.mint, borderColor: c.mint },
  tglText: { ...theme.type.ui, color: c.white },
  tglTextOn: { color: c.onMint },
  help: { ...theme.type.small, color: c.text2 },
});
