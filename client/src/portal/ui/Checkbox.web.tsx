import { theme } from '../../theme';
import type { CheckboxProps } from './Checkbox';

// The checkbox on web (home.md 4.2, spec 15.7): a real <input type="checkbox"> inside its <label>, so the label's
// whole 44px row toggles it and screen readers hear a native checkbox. The input draws the 16px box itself
// (appearance: none) with the portal's mint focus ring; checked, it takes the mint fill and a drawn `onMint`
// check. Disabled it carries aria-disabled, never the attribute, so it keeps its focus, and a change is ignored:
// the box is controlled, so React puts it back.

const c = theme.color;

export function Checkbox(props: CheckboxProps): React.JSX.Element {
  const disabled = props.disabled === true;
  return (
    <label
      style={{
        display: 'inline-flex', alignItems: 'center', columnGap: 10, minHeight: 44, cursor: disabled ? 'default' : 'pointer',
        fontFamily: theme.font.sans, fontSize: 14, lineHeight: '20px', fontWeight: 500, color: disabled ? c.text3 : c.white,
      }}
    >
      <span style={{ position: 'relative', display: 'inline-flex', width: 16, height: 16, flex: 'none' }}>
        <input
          type="checkbox"
          checked={props.checked}
          aria-disabled={disabled ? true : undefined}
          aria-describedby={props.describedBy}
          onChange={(event) => { if (!disabled) props.onChange(event.target.checked); }}
          style={{
            appearance: 'none', WebkitAppearance: 'none', width: 16, height: 16, margin: 0, borderRadius: 0,
            border: `1px solid ${disabled ? c.border : props.checked ? c.mint : c.line}`,
            background: props.checked ? c.mint : 'transparent', cursor: disabled ? 'default' : 'pointer',
          }}
        />
        {props.checked ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', left: 5, top: 2, width: 4, height: 8, borderRight: `2px solid ${c.onMint}`,
              borderBottom: `2px solid ${c.onMint}`, transform: 'rotate(45deg)', pointerEvents: 'none',
            }}
          />
        ) : null}
      </span>
      {props.label}
    </label>
  );
}
