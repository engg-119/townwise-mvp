import { theme } from '../../../theme';
import { EmptyState } from '../../ui/feedback';
import { Stack } from '../../ui/layout';
import { Small } from '../../ui/text';
import type { DocBlock } from '../../viewer/docx';
import { ITEM, TRUNCATED } from './copy';
import { cellBorder, mono, reading, region } from './dom.web';

// A Word document on its item page (P27), as text: its paragraphs in body order, a Title or Heading paragraph styled
// and marked as a heading under the item's own (levels 3 to 5), and its tables as tables. Tabs and line breaks keep
// their place. React writes every piece as text, so nothing in the document is ever markup.

const C = theme.color;

const HEADING_SIZE: Readonly<Record<1 | 2 | 3, number>> = { 1: 22, 2: 19, 3: 17 };

function Block(props: { block: DocBlock }): React.JSX.Element {
  const { block } = props;
  if (block.kind === 'table') {
    return (
      <div style={{ overflowX: 'auto', margin: '0 0 16px' }}>
        <table style={{ borderCollapse: 'collapse' }}>
          <tbody>
            {block.rows.map((row, at) => (
              <tr key={at}>
                {row.map((text, index) => (
                  <td key={index} style={{ ...mono, color: C.text2, padding: '6px 12px', border: cellBorder, whiteSpace: 'pre-wrap', verticalAlign: 'top' }}>
                    {text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.heading === 0) {
    return <p style={{ ...reading, margin: '0 0 12px', minHeight: 24, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{block.text}</p>;
  }
  const size = HEADING_SIZE[block.heading];
  return (
    <p
      role="heading"
      aria-level={2 + block.heading}
      style={{ ...reading, fontSize: size, lineHeight: `${String(size + 6)}px`, fontWeight: 600, color: C.white, margin: '8px 0 12px', whiteSpace: 'pre-wrap' }}
    >
      {block.text}
    </p>
  );
}

export function DocumentView(props: { blocks: readonly DocBlock[]; truncated: boolean; label: string }): React.JSX.Element {
  if (props.blocks.length === 0) return <EmptyState text={ITEM.emptyFile} />;
  return (
    <Stack>
      {props.truncated ? <Small>{TRUNCATED.document}</Small> : null}
      <div role="region" aria-label={props.label} tabIndex={0} style={{ ...region, padding: 20 }}>
        {props.blocks.map((block, at) => <Block key={at} block={block} />)}
      </div>
    </Stack>
  );
}
