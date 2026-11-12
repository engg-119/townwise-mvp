import { theme } from '../../../theme';
import { EmptyState } from '../../ui/feedback';
import { ITEM } from './copy';
import { mono, region } from './dom.web';

// A text file on its item page (P27): the decoded text in the portal's mono, wrapped, in a region that scrolls inside
// itself. React writes it as a text node, so nothing in it is ever markup.

export function TextView(props: { text: string; label: string }): React.JSX.Element {
  if (props.text === '') return <EmptyState text={ITEM.emptyFile} />;
  return (
    <div role="region" aria-label={props.label} tabIndex={0} style={region}>
      <pre
        style={{
          ...mono, fontSize: 14, lineHeight: '20px', color: theme.color.text2, margin: 0, padding: 16, whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {props.text}
      </pre>
    </div>
  );
}
