import { theme } from '../../theme';
import { MONTHS } from '../towns';

// The month scrubber (spec 13, P15; the design system's MonthScrubber, as on the homepage's town panel, without
// the map): twelve month buttons in a radiogroup with one tab stop. Left and Up go back a month, Right and Down
// forward, wrapping; Home and End jump to January and December. The chosen month takes the mint fill, as a
// selection. Nothing animates. Web only: native shows the text summary and the numbers instead (D21).

const C = theme.color;

function target(key: string, month: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return (month + 11) % 12;
    case 'ArrowRight':
    case 'ArrowDown':
      return (month + 1) % 12;
    case 'Home':
      return 0;
    case 'End':
      return 11;
    default:
      return null;
  }
}

export function MonthScrubber(props: { month: number; onMonth: (month: number) => void }): React.JSX.Element {
  const { month, onMonth } = props;

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const next = target(event.key, month);
    if (next === null) return;
    event.preventDefault();
    onMonth(next);
    event.currentTarget.querySelectorAll('button')[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Month" onKeyDown={onKeyDown} style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 44px)', gap: 4 }}>
      {MONTHS.map((label, index) => {
        const on = index === month;
        return (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => { onMonth(index); }}
            style={{
              width: 44, minHeight: 44, margin: 0, padding: 0, fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px',
              color: on ? C.onMint : C.text2, background: on ? C.mint : C.raised, border: `1px solid ${on ? C.mint : C.line}`,
              borderRadius: 0, cursor: 'pointer',
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
