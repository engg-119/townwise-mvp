import { useId, useState } from 'react';

import { theme } from '../../theme';
import { FieldFrame, useFieldIds } from '../ui/FormField';
import { MAX_SEARCH_LENGTH, type PlaceSuggestion } from './places';
import { PlaceSearchShell, type PlaceFieldProps, type PlaceSearchProps } from './PlaceSearchParts';
import { usePlaceSearch } from './usePlaceSearch';

// The Google Places search on web: an ARIA 1.2 combobox (a real <input role="combobox"> that owns a listbox of
// suggestions, aria-activedescendant for the active one), styled like FormField with mint on focus. Down and Up move
// through the suggestions, Enter picks the active one, Escape closes the list, then clears the text; the mouse picks
// on press without taking focus from the field. The status line (PlaceSearchParts.tsx) says how many places match,
// once per answer. Nothing animates.

export type { PlaceSearchProps } from './PlaceSearchParts';

export function PlaceSearch(props: PlaceSearchProps): React.JSX.Element {
  const state = usePlaceSearch(props.api);
  const statusId = `${useId().replace(/:/g, '')}-status`;
  return <PlaceSearchShell props={props} state={state} statusId={statusId} field={<WebField props={props} state={state} statusId={statusId} />} />;
}

const c = theme.color;

interface Cursor { list: readonly PlaceSuggestion[]; active: number; closed: boolean }

function WebField({ props, state, statusId }: PlaceFieldProps): React.JSX.Element {
  const ids = useFieldIds();
  const listId = `${ids.label}-list`;
  const [focused, setFocused] = useState(false);
  const { suggestions } = state;
  // The active suggestion and whether the list is closed belong to one answer: a new answer starts with none active
  // and the list open.
  const [cursor, setCursor] = useState<Cursor>({ list: suggestions, active: -1, closed: false });
  const { active, closed } = cursor.list === suggestions ? cursor : { active: -1, closed: false };
  const setActive = (next: (index: number) => number): void => { setCursor({ list: suggestions, active: next(active), closed: false }); };
  const setClosed = (value: boolean): void => { setCursor({ list: suggestions, active, closed: value }); };
  const open = suggestions.length > 0 && !closed;
  const activeId = open && active >= 0 ? `${listId}-${String(active)}` : undefined;

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
      case 'Enter': {
        const chosen = open && active >= 0 ? suggestions[active] : undefined;
        if (chosen === undefined) return;
        event.preventDefault();
        state.pick(chosen);
        return;
      }
      case 'Escape':
        event.preventDefault();
        if (open) setClosed(true);
        else state.setQuery('');
        return;
      default:
    }
  }

  return (
    <FieldFrame label={props.label} {...(props.helper === undefined ? {} : { helper: props.helper })} ids={ids}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <input
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
          value={state.query}
          onChange={(event) => { state.setQuery(event.target.value); }}
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
          aria-labelledby={ids.label}
          hidden={!open}
          style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${c.border}`, borderTop: 'none', background: c.panel }}
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.placeId}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={index === active}
              // Pressing keeps focus in the field, so the list stays a part of it.
              onMouseDown={(event) => { event.preventDefault(); }}
              onMouseEnter={() => { setActive(() => index); }}
              onClick={() => { state.pick(suggestion); }}
              style={{
                minHeight: 44, boxSizing: 'border-box', padding: '10px 12px', cursor: 'pointer',
                borderBottom: index === suggestions.length - 1 ? 'none' : `1px solid ${c.border}`,
                background: index === active ? c.raised : 'transparent',
                boxShadow: index === active ? `inset 3px 0 0 ${c.mint}` : 'none',
              }}
            >
              <span style={{ display: 'block', color: c.white, fontFamily: theme.font.sans, fontSize: 16, lineHeight: '24px' }}>
                {suggestion.name}
              </span>
              {suggestion.detail === '' ? null : (
                <span style={{ display: 'block', color: c.text2, fontFamily: theme.font.sans, fontSize: 14, lineHeight: '20px' }}>
                  {suggestion.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </FieldFrame>
  );
}
