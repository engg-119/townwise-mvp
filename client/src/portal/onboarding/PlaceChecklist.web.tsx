import { useId, useState } from 'react';

import { theme } from '../../theme';
import { useFocusOnMount } from '../places/focus';
import { FieldFrame, useFieldIds } from '../ui/FormField';
import { MAX_SEARCH_LENGTH, type PlaceSuggestion } from './places';
import { PlaceChecklistShell, type ChecklistFieldProps, type PlaceChecklistProps } from './PlaceChecklistParts';

// The places checklist on web (PlaceChecklist.tsx is native's): PlaceSearch.web's ARIA 1.2 combobox with a
// multiselectable listbox. Each option's aria-selected says whether its place is checked; the active option shows only
// by highlight and aria-activedescendant. Down and Up move the active option; Enter, and Space while an option is
// active, toggle it and leave the list open (with none active Space types); typing clears the active option and opens
// the list again. A mouse press toggles without taking focus from the field. A refused or full option is
// aria-disabled. Each option starts with a drawn 16px box, hidden from assistive technology, in Checkbox.web's colors.
// Remove gives the field focus back. Escape closes the list, then clears the text. Nothing animates.

export type { PlaceChecklistProps } from './PlaceChecklistParts';

export function PlaceChecklist(props: PlaceChecklistProps): React.JSX.Element {
  const statusId = `${useId().replace(/:/g, '')}-status`;
  const input = useFocusOnMount<HTMLInputElement>(props.autoFocus === true);
  return (
    <PlaceChecklistShell
      props={props}
      statusId={statusId}
      onRemove={() => { input.current?.focus(); }}
      field={<WebField props={props} state={props.state} statusId={statusId} input={input} />}
    />
  );
}

const c = theme.color;

interface Cursor { list: readonly PlaceSuggestion[]; active: number; closed: boolean }

function WebField({ props, state, statusId, input }: ChecklistFieldProps & { input: React.RefObject<HTMLInputElement | null> }): React.JSX.Element {
  const ids = useFieldIds();
  const listId = `${ids.label}-list`;
  const [focused, setFocused] = useState(false);
  const off = props.disabled === true;
  const { search } = state;
  const { suggestions } = search;
  // The active suggestion and whether the list is closed belong to one answer: a new answer starts with none active
  // and the list open.
  const [cursor, setCursor] = useState<Cursor>({ list: suggestions, active: -1, closed: false });
  const { active, closed } = cursor.list === suggestions ? cursor : { active: -1, closed: false };
  const setActive = (next: (index: number) => number): void => { setCursor({ list: suggestions, active: next(active), closed: false }); };
  const setClosed = (value: boolean): void => { setCursor({ list: suggestions, active, closed: value }); };
  const open = suggestions.length > 0 && !closed;
  const activeId = open && active >= 0 ? `${listId}-${String(active)}` : undefined;
  const optionDisabled = (suggestion: PlaceSuggestion): boolean => off || state.optionOf(suggestion).disabled;
  const toggle = (suggestion: PlaceSuggestion): void => { if (!optionDisabled(suggestion)) state.toggle(suggestion); };

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        if (suggestions.length === 0) return;
        event.preventDefault();
        setActive((index) => (open ? Math.min(index + 1, suggestions.length - 1) : 0));
        return;
      case 'ArrowUp':
        if (!open) return;
        event.preventDefault();
        setActive((index) => Math.max(index - 1, -1));
        return;
      case 'Enter':
      case ' ': {
        const chosen = open && active >= 0 ? suggestions[active] : undefined;
        if (chosen === undefined) return;
        event.preventDefault();
        toggle(chosen);
        return;
      }
      case 'Escape':
        event.preventDefault();
        if (open) setClosed(true);
        else search.setQuery('');
        return;
      default:
    }
  }

  return (
    <FieldFrame label={props.label} {...(props.helper === undefined ? {} : { helper: props.helper })} ids={ids}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-labelledby={ids.label}
          aria-describedby={[props.helper === undefined ? null : ids.helper, statusId].filter((id) => id !== null).join(' ')}
          autoComplete="off"
          autoCapitalize="words"
          spellCheck={false}
          maxLength={MAX_SEARCH_LENGTH}
          disabled={off}
          value={search.query}
          onChange={(event) => {
            search.setQuery(event.target.value);
            setCursor({ list: suggestions, active: -1, closed: false });
          }}
          onKeyDown={onKeyDown}
          onFocus={() => { setFocused(true); setClosed(false); }}
          onBlur={() => { setFocused(false); setClosed(true); }}
          style={{
            boxSizing: 'border-box', width: '100%', minHeight: 44, margin: 0, padding: '0 12px', background: c.ground, color: c.white,
            border: `1px solid ${focused ? c.mint : c.line}`, borderRadius: 0, fontFamily: theme.font.sans, fontSize: 16, lineHeight: '24px',
          }}
        />
        <ul
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-labelledby={ids.label}
          hidden={!open}
          style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${c.border}`, borderTop: 'none', background: c.panel }}
        >
          {suggestions.map((suggestion, index) => {
            const { checked } = state.optionOf(suggestion);
            const disabled = optionDisabled(suggestion);
            return (
              <li
                key={suggestion.placeId}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-selected={checked}
                aria-disabled={disabled ? true : undefined}
                // Pressing keeps focus in the field, so the list stays a part of it.
                onMouseDown={(event) => { event.preventDefault(); }}
                onMouseEnter={() => { setActive(() => index); }}
                onClick={() => { toggle(suggestion); }}
                style={{
                  display: 'flex', alignItems: 'center', columnGap: 10, minHeight: 44, boxSizing: 'border-box', padding: '10px 12px',
                  cursor: disabled ? 'default' : 'pointer', borderBottom: index === suggestions.length - 1 ? 'none' : `1px solid ${c.border}`,
                  background: index === active ? c.raised : 'transparent', boxShadow: index === active ? `inset 3px 0 0 ${c.mint}` : 'none',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: 'relative', flex: 'none', width: 16, height: 16, boxSizing: 'border-box',
                    border: `1px solid ${disabled ? c.border : checked ? c.mint : c.line}`, background: checked ? c.mint : 'transparent',
                  }}
                >
                  {checked ? (
                    <span
                      style={{
                        position: 'absolute', left: 4, top: 1, width: 4, height: 8, borderRight: `2px solid ${c.onMint}`,
                        borderBottom: `2px solid ${c.onMint}`, transform: 'rotate(45deg)',
                      }}
                    />
                  ) : null}
                </span>
                <span>
                  <span style={{ display: 'block', color: disabled ? c.text3 : c.white, fontFamily: theme.font.sans, fontSize: 16, lineHeight: '24px' }}>
                    {suggestion.name}
                  </span>
                  {suggestion.detail === '' ? null : (
                    <span style={{ display: 'block', color: c.text2, fontFamily: theme.font.sans, fontSize: 14, lineHeight: '20px' }}>
                      {suggestion.detail}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </FieldFrame>
  );
}
