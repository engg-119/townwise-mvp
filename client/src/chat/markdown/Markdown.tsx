import { Link } from 'expo-router';
import { useMemo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { theme } from '../../theme';
import { parseMarkdown, type MdBlock, type MdInline } from './parse';

// A reply drawn from its Markdown (spec P25): paragraphs in `sub`, headings in bold `ui`, lists with mono markers,
// code in mono on `panel` with a 1px `border`, quotes with a 2px `line` rule, links underlined (a new tab on web,
// the system browser on native), and tables in NumbersTable cells inside a horizontal scroller so the page never
// scrolls sideways. `caret` appends a static U+258D to the last block that holds text, or on its own line after a
// table, code block or rule; assistive technology skips it.

const CARET = '▍';
const web = Platform.OS === 'web';
// react-native-web passes overflowWrap through; the native style types don't list it.
const wrap = web ? ({ overflowWrap: 'anywhere' } as TextStyle) : null;

function Caret(): React.JSX.Element {
  return <Text aria-hidden style={styles.caret}>{CARET}</Text>;
}

function Inlines(props: { nodes: readonly MdInline[] }): React.JSX.Element {
  return (
    <>
      {props.nodes.map((node, index) => {
        switch (node.t) {
          case 'text': return <Text key={index}>{node.text}</Text>;
          case 'break': return <Text key={index}>{'\n'}</Text>;
          case 'code': return <Text key={index} style={styles.inlineCode}>{node.text}</Text>;
          case 'strong': return <Text key={index} style={styles.strong}><Inlines nodes={node.children} /></Text>;
          case 'em': return <Text key={index} style={styles.em}><Inlines nodes={node.children} /></Text>;
          case 'del': return <Text key={index} style={styles.del}><Inlines nodes={node.children} /></Text>;
          case 'link':
            if (node.href === null) return <Text key={index}><Inlines nodes={node.children} /></Text>;
            return (
              <Link key={index} href={node.href} target="_blank" rel="noopener noreferrer" style={styles.link}>
                <Inlines nodes={node.children} />
              </Link>
            );
        }
      })}
    </>
  );
}

function Table(props: { block: Extract<MdBlock, { t: 'table' }> }): React.JSX.Element {
  const { block } = props;
  const rowOf = (cells: readonly MdInline[][], head: boolean, last: boolean) => (
    <View role="row" style={[styles.row, last ? styles.lastRow : null]}>
      {block.head.map((_, column) => (
        <View key={column} role={head ? 'columnheader' : 'cell'} style={styles.cell}>
          <Text selectable style={[styles.cellText, head ? styles.headText : null, { textAlign: block.align[column] ?? 'left' }]}>
            <Inlines nodes={cells[column] ?? []} />
          </Text>
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView
      horizontal
      {...(web ? { role: 'region', 'aria-label': 'Table', tabIndex: 0 } : null)}
      style={styles.scroller}
      contentContainerStyle={styles.scrollContent}
    >
      <View role="table" style={styles.table}>
        <View role="rowgroup">{rowOf(block.head, true, false)}</View>
        <View role="rowgroup">
          {block.rows.map((cells, index) => <View key={index}>{rowOf(cells, false, index === block.rows.length - 1)}</View>)}
        </View>
      </View>
    </ScrollView>
  );
}

function Blocks(props: { blocks: readonly MdBlock[]; caret: boolean }): React.JSX.Element {
  const { blocks, caret } = props;
  if (blocks.length === 0) return caret ? <View style={styles.caretLine}><Caret /></View> : <></>;
  return (
    <>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} caret={caret && index === blocks.length - 1} />
      ))}
    </>
  );
}

function BlockView(props: { block: MdBlock; caret: boolean }): React.JSX.Element {
  const { block, caret } = props;
  switch (block.t) {
    case 'paragraph':
      return <Text selectable style={[styles.paragraph, wrap]}><Inlines nodes={block.children} />{caret ? <Caret /> : null}</Text>;
    case 'heading':
      return (
        <Text selectable role="heading" aria-level={block.level <= 3 ? 3 : 4} style={[styles.heading, wrap]}>
          <Inlines nodes={block.children} />{caret ? <Caret /> : null}
        </Text>
      );
    case 'list':
      return (
        <View role="list" style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} role="listitem" style={styles.item}>
              <Text style={styles.marker}>{block.ordered ? `${block.start + index}.` : '•'}</Text>
              <View style={styles.itemBody}>
                <Blocks blocks={item} caret={caret && index === block.items.length - 1} />
              </View>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return <View style={styles.quote}><Blocks blocks={block.children} caret={caret} /></View>;
    case 'code':
      return (
        <>
          <ScrollView horizontal style={styles.codeScroller} contentContainerStyle={styles.codeContent}>
            <Text selectable style={styles.codeText}>{block.text}</Text>
          </ScrollView>
          {caret ? <View style={styles.caretLine}><Caret /></View> : null}
        </>
      );
    case 'rule':
      return (
        <>
          <View style={styles.rule} />
          {caret ? <View style={styles.caretLine}><Caret /></View> : null}
        </>
      );
    case 'table':
      return (
        <>
          <Table block={block} />
          {caret ? <View style={styles.caretLine}><Caret /></View> : null}
        </>
      );
  }
}

export function Markdown(props: { source: string; caret?: boolean }): React.JSX.Element {
  const blocks = useMemo(() => parseMarkdown(props.source), [props.source]);
  return (
    <View style={styles.root}>
      <Blocks blocks={blocks} caret={props.caret === true} />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  root: { gap: theme.space[3], minWidth: 0 },
  paragraph: { ...theme.type.sub, color: c.white },
  heading: { ...theme.type.ui, fontWeight: '700', color: c.white },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  link: { color: c.white, textDecorationLine: 'underline' },
  inlineCode: { ...theme.type.mono, color: c.white, backgroundColor: c.panel, borderWidth: 1, borderColor: c.border },
  list: { gap: theme.space[2] },
  item: { flexDirection: 'row', columnGap: theme.space[2] },
  marker: { ...theme.type.mono, color: c.text2, minWidth: 20, paddingTop: 4 },
  itemBody: { flex: 1, minWidth: 0, gap: theme.space[2] },
  quote: { borderLeftWidth: 2, borderLeftColor: c.line, paddingLeft: theme.space[3], gap: theme.space[3] },
  codeScroller: { backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, flexGrow: 0 },
  codeContent: { padding: theme.space[3] },
  codeText: { ...theme.type.mono, color: c.white },
  rule: { height: 1, backgroundColor: c.border },
  caret: { color: c.text2 },
  caretLine: { flexDirection: 'row' },
  scroller: { flexGrow: 0, minWidth: 0, borderWidth: 1, borderColor: c.border },
  scrollContent: { minWidth: '100%' },
  table: { minWidth: '100%' },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.border },
  lastRow: { borderBottomWidth: 0 },
  cell: { minWidth: 112, flexGrow: 1, flexBasis: 0, justifyContent: 'center', paddingVertical: 6, paddingLeft: 8, paddingRight: 16 },
  cellText: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  headText: { color: c.text3 },
});
