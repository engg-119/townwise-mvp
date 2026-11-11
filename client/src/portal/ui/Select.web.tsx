import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { theme } from '../../theme';
import { describedBy, FieldFrame, useFieldIds, type FieldChrome } from './FormField';
import { isGroup, labelOf, type SelectOption, type SelectProps } from './selectTypes';

// The select on web: an ARIA 1.2 select-only combobox, styled like a FormField input with the shell's drawn
// chevron, whose list is drawn in the app's style instead of the operating system's. The control keeps focus and
// points at the highlighted choice with aria-activedescendant, as PlaceSearch.web.tsx does. Down, Up, Enter or Space
// open the list at the current choice; Down, Up, Home, End, Page Up and Page Down move; Enter or Space picks;
// Escape and Tab close it unchanged; typing jumps to the first choice whose label starts with the letters typed (or
// whose value is exactly them, so "nh" finds New Hampshire). The mouse picks on press without taking focus from the
// control. Groups are labelled in the list as the native sheet's are (Select.tsx). The list is drawn on the page's
// body at a fixed position under the control (above it when there is more room there), since every react-native-web
// View is its own stacking context and would paint over a list nested inside it. Nothing animates. Under view-as it
// carries aria-disabled, stays focusable, and does not open.

const c = theme.color;
/** The list's tallest, about seven choices. */
const MAX_HEIGHT = 320;
/** The gap between the control and its list, and the least room kept to the window's edge. */
const GAP = 4;
const EDGE = 8;
/** How long typed letters keep adding to one search. */
const TYPE_AHEAD_MS = 600;

interface Row { option: SelectOption; index: number }
interface Section { label: string | null; rows: Row[] }
interface Spot { left: number; width: number; up: boolean; edge: number; maxHeight: number }
interface Menu { active: number; spot: Spot }

/** The choices in order (the placeholder first), split where the groups start and end. */
function sectionsOf(items: SelectProps['items'], placeholder: string | undefined): Section[] {
  const sections: Section[] = [];
  let index = 0;
  const next = (option: SelectOption): Row => {
    const row = { option, index };
    index += 1;
    return row;
  };
  const loose = (option: SelectOption): void => {
    const last = sections.at(-1);
    if (last?.label === null) last.rows.push(next(option));
    else sections.push({ label: null, rows: [next(option)] });
  };
  if (placeholder !== undefined) loose({ value: '', label: placeholder });
  for (const item of items) {
    if (isGroup(item)) sections.push({ label: item.label, rows: item.options.map(next) });
    else loose(item);
  }
  return sections;
}

/** Where the list goes: under the control, or over it when the room below is short and the room above is larger. */
function spotFor(box: DOMRect): Spot {
  const below = window.innerHeight - box.bottom - GAP - EDGE;
  const above = box.top - GAP - EDGE;
  const up = below < 200 && above > below;
  const room = up ? above : below;
  return {
    left: box.left, width: box.width, up, edge: up ? window.innerHeight - box.top + GAP : box.bottom + GAP,
    maxHeight: Math.max(Math.min(MAX_HEIGHT, room), 88),
  };
}

export function Select(props: SelectProps): React.JSX.Element {
  const fieldIds = useFieldIds();
  const listId = `${fieldIds.label}-list`;
  const optionId = (index: number): string => `${listId}-${String(index)}`;
  const control = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const readOnly = props.readOnly === true;
  const chrome: FieldChrome = props;
  const invalid = (props.messages?.length ?? 0) > 0;
  const sections = sectionsOf(props.items, props.placeholder);
  const options = sections.flatMap((section) => section.rows.map((row) => row.option));
  const label = labelOf(props.items, props.value);
  const showsPlaceholder = label === null && props.value === '' && props.placeholder !== undefined;
  const open = menu !== null;
  const active = menu === null || menu.active >= options.length ? -1 : menu.active;
  const border = readOnly ? c.border : focused ? c.mint : c.line;

  function current(): number {
    const index = options.findIndex((option) => option.value === props.value);
    return index === -1 ? 0 : index;
  }

  function openAt(index: number): void {
    const box = control.current?.getBoundingClientRect();
    if (box === undefined || options.length === 0) return;
    setMenu({ active: index, spot: spotFor(box) });
  }

  function moveTo(index: number): void {
    setMenu((shown) => (shown === null ? null : { ...shown, active: Math.min(Math.max(index, 0), options.length - 1) }));
  }

  /** Closes the list; the next letter typed starts a new search. */
  function close(): void {
    typed.current = { text: '', at: 0 };
    setMenu(null);
  }

  function choose(index: number): void {
    const option = options[index];
    close();
    if (option !== undefined && option.value !== props.value) props.onChange(option.value);
  }

  /** The choice the letters typed so far point at, from the one after `from`; -1 when none does. */
  function typeAhead(key: string, from: number, now: number): number {
    const text = (typing(now) ? typed.current.text : '') + key.toLowerCase();
    typed.current = { text, at: now };
    // One letter, or the same letter again, steps through the choices that start with it, as a native select does.
    const repeat = text.replaceAll(text.charAt(0), '') === '';
    const needle = repeat ? text.charAt(0) : text;
    const start = repeat ? from + 1 : Math.max(from, 0);
    const order = options.map((_, step) => (start + step) % options.length);
    const byLabel = order.find((index) => options[index]?.label.toLowerCase().startsWith(needle) === true);
    if (byLabel !== undefined) return byLabel;
    return options.findIndex((option) => option.value.toLowerCase() === text);
  }

  /** Whether a search is still being typed: the last letter came under TYPE_AHEAD_MS before `now`. */
  function typing(now: number): boolean {
    return typed.current.text !== '' && now - typed.current.at < TYPE_AHEAD_MS;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (readOnly || event.ctrlKey || event.metaKey) return;
    const { key, timeStamp: now } = event;
    const letter = key.length === 1 && !event.altKey && !(key === ' ' && !typing(now));
    if (letter) {
      event.preventDefault();
      const found = typeAhead(key, open ? active : current(), now);
      if (found === -1) return;
      if (open) moveTo(found);
      else openAt(found);
      return;
    }
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault();
        openAt(current());
      } else if (key === 'Home' || key === 'End') {
        event.preventDefault();
        openAt(key === 'Home' ? 0 : options.length - 1);
      }
      return;
    }
    switch (key) {
      case 'ArrowDown': event.preventDefault(); moveTo(active + 1); return;
      case 'ArrowUp': event.preventDefault(); moveTo(active - 1); return;
      case 'Home': event.preventDefault(); moveTo(0); return;
      case 'End': event.preventDefault(); moveTo(options.length - 1); return;
      case 'PageDown': event.preventDefault(); moveTo(active + 10); return;
      case 'PageUp': event.preventDefault(); moveTo(active - 10); return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(active);
        return;
      case 'Escape':
        // Only the list closes, not a dialog the select sits in.
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case 'Tab':
        close();
        return;
      default:
    }
  }

  // While the list is open it follows the control when the page scrolls or the window changes size.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const follow = (event: Event): void => {
      if (event.target === list.current) return;
      const box = control.current?.getBoundingClientRect();
      if (box !== undefined) setMenu((shown) => (shown === null ? null : { ...shown, spot: spotFor(box) }));
    };
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open]);

  // The list opens with the current choice in its middle, then scrolls only as far as the highlighted one needs.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const box = list.current;
    const item = active < 0 ? null : document.getElementById(optionId(active));
    if (!open || box === null || item === null) {
      opened.current = open;
      return;
    }
    if (!opened.current) {
      box.scrollTop = item.offsetTop - (box.clientHeight - item.offsetHeight) / 2;
    } else if (item.offsetTop < box.scrollTop) {
      box.scrollTop = item.offsetTop;
    } else if (item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight;
    }
    opened.current = true;
  });

  function renderRow({ option, index }: Row): React.JSX.Element {
    const highlighted = index === active;
    // The placeholder ("Choose a state") is a prompt, so it reads as one in the list too: text3, never the check.
    const prompt = props.placeholder !== undefined && index === 0;
    const chosen = !prompt && option.value === props.value;
    return (
      <div
        key={`${String(index)}-${option.value}`}
        id={optionId(index)}
        role="option"
        aria-selected={highlighted}
        onMouseMove={() => { if (!highlighted) moveTo(index); }}
        onClick={() => { choose(index); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, boxSizing: 'border-box', padding: '10px 12px',
          cursor: 'pointer', background: highlighted ? c.raised : 'transparent', boxShadow: highlighted ? `inset 3px 0 0 ${c.mint}` : 'none',
          color: prompt ? c.text3 : chosen ? c.mint : c.white, fontFamily: theme.font.sans, fontSize: 16, lineHeight: '24px',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{option.label}</span>
        {chosen ? (
          <span
            aria-hidden="true"
            style={{
              flex: 'none', width: 5, height: 10, marginRight: 4, marginTop: -3, borderRight: `1.5px solid ${c.mint}`,
              borderBottom: `1.5px solid ${c.mint}`, transform: 'rotate(45deg)',
            }}
          />
        ) : null}
      </div>
    );
  }

  const listbox = menu === null ? null : (
    <div
      ref={list}
      id={listId}
      role="listbox"
      aria-labelledby={fieldIds.label}
      // Pressing anywhere in the list, its scrollbar too, keeps focus on the control, so the list stays a part of it.
      // React bubbles a portal's events to the select's parents, so a press here never reaches them.
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => { event.stopPropagation(); }}
      style={{
        position: 'fixed', zIndex: 10000, left: menu.spot.left, width: menu.spot.width, maxHeight: menu.spot.maxHeight,
        ...(menu.spot.up ? { bottom: menu.spot.edge } : { top: menu.spot.edge }),
        boxSizing: 'border-box', overflowY: 'auto', overscrollBehavior: 'contain', margin: 0, padding: '4px 0',
        background: c.panel, border: `1px solid ${c.line}`, borderRadius: 0, boxShadow: '0 12px 32px rgba(0, 0, 0, 0.6)',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {sections.map((section, at) => (section.label === null ? section.rows.map(renderRow) : (
        <div
          key={`g-${section.label}`}
          role="group"
          aria-labelledby={`${listId}-g${String(at)}`}
          style={{ borderTop: at === 0 ? 'none' : `1px solid ${c.border}`, marginTop: at === 0 ? 0 : 4 }}
        >
          <div
            id={`${listId}-g${String(at)}`}
            role="presentation"
            style={{
              padding: '12px 12px 4px', color: c.text3, fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px',
              letterSpacing: 0.48, textTransform: 'uppercase',
            }}
          >
            {section.label}
          </div>
          {section.rows.map(renderRow)}
        </div>
      )))}
    </div>
  );

  return (
    <FieldFrame {...chrome} ids={fieldIds}>
      <div
        ref={control}
        role="combobox"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        aria-labelledby={fieldIds.label}
        aria-describedby={describedBy(chrome, fieldIds)}
        aria-invalid={invalid ? true : undefined}
        aria-disabled={readOnly ? true : undefined}
        onKeyDown={onKeyDown}
        onClick={() => { if (readOnly) return; if (open) close(); else openAt(current()); }}
        onFocus={() => { setFocused(true); }}
        onBlur={() => { setFocused(false); close(); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, boxSizing: 'border-box', width: '100%', minHeight: 44,
          maxWidth: props.compact === true ? 280 : undefined, margin: 0, padding: '0 16px 0 12px', background: c.ground,
          border: `1px solid ${border}`, borderRadius: 0, cursor: readOnly ? 'default' : 'pointer', userSelect: 'none',
          fontFamily: theme.font.sans, fontSize: 16, lineHeight: '24px',
          color: readOnly ? c.text3 : showsPlaceholder ? c.text3 : c.white,
        }}
      >
        {/* A long choice (the location switcher on phones) ends in an ellipsis instead of being cut off. */}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {label ?? (showsPlaceholder ? props.placeholder : '')}
        </span>
        <span
          aria-hidden="true"
          style={{
            flex: 'none', width: 7, height: 7, borderRight: `1.5px solid ${c.text2}`, borderBottom: `1.5px solid ${c.text2}`,
            transform: open ? 'translateY(2px) rotate(225deg)' : 'translateY(-2px) rotate(45deg)',
          }}
        />
      </div>
      {listbox === null ? null : createPortal(listbox, document.body)}
    </FieldFrame>
  );
}
