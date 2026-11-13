import { useId } from 'react';

import { theme } from '../../../theme';
import { Stack } from '../../ui/layout';
import { Small } from '../../ui/text';
import { VIEW_LIMITS } from '../../viewer/limits';
import { charsLeftLine } from './copy';
import { mono } from './dom.web';

// A text file edited on its item page (P27, web): a <textarea> of the decoded text, named after the item, taking
// focus when it opens (the Edit button it replaces is gone). At most VIEW_LIMITS.editTextChars characters; in the last
// NEAR of them a line under it, tied by aria-describedby, says how many are left.

const NEAR = 10_000;

export function TextEditor(props: { text: string; label: string; disabled: boolean; onChange: (text: string) => void }): React.JSX.Element {
  const id = `${useId().replace(/:/g, '')}-left`;
  const max = VIEW_LIMITS.editTextChars;
  const left = max - props.text.length;
  const near = left <= NEAR;
  return (
    <Stack gap={theme.space[2]}>
      <textarea
        aria-label={props.label}
        aria-describedby={near ? id : undefined}
        value={props.text}
        maxLength={max}
        readOnly={props.disabled}
        autoFocus
        spellCheck={false}
        onChange={(event) => { props.onChange(event.target.value.slice(0, max)); }}
        style={{
          ...mono, fontSize: 14, lineHeight: '20px', color: theme.color.white, background: theme.color.ground, padding: 16, minHeight: 360,
          width: '100%', boxSizing: 'border-box', resize: 'vertical', border: `1px solid ${theme.color.line}`, borderRadius: 0,
        }}
      />
      {near ? <Small nativeID={id}>{charsLeftLine(Math.max(0, left))}</Small> : null}
    </Stack>
  );
}
