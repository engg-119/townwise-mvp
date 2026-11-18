import { StyleSheet, Text, View, type DimensionValue } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { MIN_FLEX_WIDTH } from '../ui/DataTable';
import { Panel } from '../ui/layout';
import { Pulse } from './Pulse';

// The skeleton kit (spec 15.7 Loading): shapes that stand in for a page's content while it loads, each the size of
// what it stands for, so nothing moves when the content arrives. Square `raised` blocks for text and figures, `line`
// outlines for controls, the `panel` surface for panels; no mint (it is for data and selection), no sample values.
// Screen readers hear one polite status line with the page's loading words; the shapes are hidden from them.

const c = theme.color;

export type SkeletonType = 'small' | 'body' | 'sub' | 'ui' | 'mono' | 'label';

/** A type's size and line height, as the type components set them per breakpoint (ui/text.tsx). */
function typeOf(type: SkeletonType, phone: boolean): { fontSize: number; lineHeight: number } {
  switch (type) {
    case 'small': return phone ? theme.type.sub : theme.type.small;
    case 'body': return phone ? theme.type.bodyPhone : theme.type.body;
    case 'sub': return theme.type.sub;
    case 'ui': return theme.type.ui;
    case 'mono': return theme.type.mono;
    case 'label': return theme.type.label;
  }
}

/**
 * A loading page or section: the status line screen readers hear (`label`, the page's loading words, polite), then
 * the shapes, hidden from assistive tech and pulsing in opacity unless motion is reduced. `name` marks it for tests.
 */
export function Skeleton(props: { name: string; label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View testID={`skeleton-${props.name}`}>
      <Text role="status" aria-live="polite" style={styles.unseen}>{props.label}</Text>
      <Pulse>{props.children}</Pulse>
    </View>
  );
}

/** A plain block: a `raised` fill, or a 1px `line` outline for a control. */
export function SkeletonBlock(props: { width?: DimensionValue; height: number; outline?: boolean }): React.JSX.Element {
  return <View style={[props.outline === true ? styles.outline : styles.fill, { width: props.width ?? '100%', height: props.height }]} />;
}

/**
 * Lines of text in `type`: each line reserves the type's line height (16/24 small text on phones, as `Small` sets
 * it), with a bar as tall as the type's size. The last of several lines is shorter.
 */
export function SkeletonText(props: { lines?: number; type?: SkeletonType; width?: DimensionValue; lastWidth?: DimensionValue }): React.JSX.Element {
  const { phone } = useBreakpoint();
  const type = typeOf(props.type ?? 'small', phone);
  const count = props.lines ?? 1;
  return (
    <View>
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={[styles.line, { height: type.lineHeight }]}>
          <View
            style={[styles.fill, {
              height: type.fontSize,
              width: count > 1 && index === count - 1 ? (props.lastWidth ?? '60%') : (props.width ?? '100%'),
            }]}
          />
        </View>
      ))}
    </View>
  );
}

/**
 * A section's head (`Section`, `Heading`): the eyebrow 8px above the heading, `tw-h3` (28, 24 on phones), or the
 * page title's size when `big`.
 */
export function SkeletonHeading(props: { kicker?: boolean; big?: boolean; width?: DimensionValue }): React.JSX.Element {
  const { phone, desktop } = useBreakpoint();
  const size = props.big === true
    ? (phone ? theme.type.h2Phone : desktop ? theme.type.h2 : theme.type.h2Tablet)
    : (phone ? theme.type.h3Phone : theme.type.h3);
  return (
    <View style={styles.head}>
      {props.kicker === true ? <SkeletonText type="label" width={120} /> : null}
      <View style={[styles.line, { height: size.lineHeight }]}>
        <View style={[styles.fill, { height: size.fontSize, width: props.width ?? 280, maxWidth: '100%' }]} />
      </View>
    </View>
  );
}

/** A figure: the value (`value`, 56; 40 on phones) over its mono label. */
export function SkeletonFigure(props: { width?: DimensionValue }): React.JSX.Element {
  const { phone } = useBreakpoint();
  const value = phone ? theme.type.valuePhone : theme.type.value;
  return (
    <View style={styles.figure}>
      <View style={[styles.line, { height: value.lineHeight }]}>
        <View style={[styles.fill, { height: value.fontSize, width: props.width ?? 160, maxWidth: '100%' }]} />
      </View>
      <SkeletonText type="label" width={96} />
    </View>
  );
}

/** A card or panel: the `panel` surface with its padding (`Panel`), holding other shapes or a fixed height. */
export function SkeletonPanel(props: { children?: React.ReactNode; minHeight?: number }): React.JSX.Element {
  return <Panel {...(props.minHeight === undefined ? {} : { style: { minHeight: props.minHeight } })}>{props.children}</Panel>;
}

/** A form field (FormField): its label, the 44px input outlined in `line`, and a helper line when it has one. */
export function SkeletonField(props: { helper?: boolean; height?: number; width?: DimensionValue }): React.JSX.Element {
  return (
    <View style={[styles.field, props.width === undefined ? null : { width: props.width, maxWidth: '100%' }]}>
      <SkeletonText type="ui" width={120} />
      <SkeletonBlock outline height={props.height ?? 44} />
      {/* The helper is `small` at every width (14/20, as `ui`). */}
      {props.helper === true ? <SkeletonText type="ui" width="70%" /> : null}
    </View>
  );
}

/** A button (44px): an outline, or for a text link its words alone. */
export function SkeletonButton(props: { width?: number; link?: boolean; testID?: string }): React.JSX.Element {
  if (props.link === true) {
    return (
      <View testID={props.testID} style={[styles.button, styles.line]}>
        <View style={[styles.fill, { height: theme.type.ui.fontSize, width: props.width ?? 120 }]} />
      </View>
    );
  }
  return <View testID={props.testID} style={[styles.button, styles.outline, { width: props.width ?? 160 }]} />;
}

export interface SkeletonColumn {
  /** The column's share of the width; 1 by default, as DataTable's. */
  flex?: number;
  /** Right-aligned, as a count or money column is. */
  numeric?: boolean;
}

/**
 * A table (DataTable) with `rows` rows: a head row and rows of at least 44px (`rowHeight` for taller rows) with
 * 1px `border` rules, with the same columns and widths, so below 1024px it keeps the table's minimum width (clipped,
 * not scrolled). At 640px and below each row is stacked label and value pairs, as DataTable's are, unless `stack`
 * is false.
 */
export function SkeletonTable(props: {
  columns: readonly SkeletonColumn[];
  rows?: number;
  rowHeight?: number;
  /** False for a table that stays one table on phones, as By month does; `belowDesktop` for one that stacks below 1024px. */
  stack?: boolean | 'belowDesktop';
}): React.JSX.Element {
  const { phone, desktop } = useBreakpoint();
  const { columns } = props;
  const rows = Array.from({ length: props.rows ?? 3 }, (_, index) => index);
  const last = rows.length - 1;
  if (props.stack === 'belowDesktop' ? !desktop : phone && props.stack !== false) {
    return (
      <View>
        {rows.map((row) => (
          <View key={row} style={[styles.stackedRow, row === last ? styles.lastRow : null]}>
            {columns.map((_, index) => (
              <View key={index} style={styles.pair}>
                <View style={styles.headLine}><SkeletonText type="mono" width={72} /></View>
                <SkeletonText type="mono" width="60%" />
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  }
  const flex = columns.reduce((sum, column) => sum + (column.flex ?? 1), 0);
  const minWidth = desktop ? null : { minWidth: Math.ceil(flex * MIN_FLEX_WIDTH) };
  const cells = (width: DimensionValue, head: boolean) => columns.map((column, index) => (
    <View key={index} style={[styles.cell, { flex: column.flex ?? 1 }]}>
      <View style={head ? styles.headLine : null}>
        <View style={[styles.line, styles.monoLine, column.numeric === true ? styles.numeric : null]}>
          <View style={[styles.fill, styles.monoBar, { width }]} />
        </View>
      </View>
    </View>
  ));
  return (
    <View style={styles.clip}>
      <View style={minWidth}>
        <View style={styles.headRow}>{cells('50%', true)}</View>
        {rows.map((row) => (
          <View key={row} style={[styles.row, { minHeight: props.rowHeight ?? 44 }, row === last ? styles.lastRow : null]}>
            {cells('70%', false)}
          </View>
        ))}
      </View>
    </View>
  );
}

/** A chart's area: a `raised` block of the chart's height, with its baseline. */
export function SkeletonChart(props: { height: number }): React.JSX.Element {
  return <View style={[styles.fill, styles.chart, { height: props.height }]} />;
}

/** A definition list (DefinitionList): `rows` term and value pairs, side by side, or stacked on phones. */
export function SkeletonDefinitions(props: { rows: number }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <View style={phone ? null : styles.definitions}>
      {Array.from({ length: props.rows }, (_, index) => (
        <View key={index} style={phone ? styles.definitionStacked : styles.definition}>
          {/* DefinitionList's text is `small` at every width (14/20, as `ui`). */}
          <View style={phone ? null : styles.term}><SkeletonText type="ui" width={phone ? 96 : 120} /></View>
          <View style={styles.definitionValue}><SkeletonText type="ui" width="60%" /></View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Read by screen readers, but takes no space and shows nothing (as the copy buttons' result line).
  unseen: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
  fill: { backgroundColor: c.raised, borderRadius: 0 },
  outline: { borderWidth: 1, borderColor: c.line, borderRadius: 0 },
  line: { justifyContent: 'center' },
  head: { gap: theme.space[2] },
  figure: { gap: theme.space[2] },
  field: { gap: theme.space[2], minWidth: 0 },
  button: { minHeight: 44 },
  chart: { borderBottomWidth: 1, borderBottomColor: c.border },
  clip: { overflow: 'hidden', minWidth: 0 },
  headRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border },
  lastRow: { borderBottomWidth: 0 },
  cell: { minWidth: 0, justifyContent: 'center', paddingVertical: 6, paddingLeft: 8, paddingRight: 16 },
  numeric: { alignItems: 'flex-end' },
  monoLine: { height: theme.type.mono.lineHeight },
  monoBar: { height: theme.type.mono.fontSize },
  // DataTable's head text has 2px above and below.
  headLine: { paddingVertical: 2 },
  stackedRow: { paddingVertical: theme.space[2], borderBottomWidth: 1, borderBottomColor: c.border },
  pair: { rowGap: 2, paddingVertical: 4, paddingHorizontal: 8 },
  definitions: { gap: theme.space[2] },
  definition: { flexDirection: 'row', columnGap: theme.space[6] },
  definitionStacked: { marginBottom: theme.space[3] },
  term: { width: 200 },
  definitionValue: { flex: 1, minWidth: 0 },
});
