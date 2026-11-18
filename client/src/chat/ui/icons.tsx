import Svg, { Path } from 'react-native-svg';

// TownwiseAI's icons, stroked or filled in the color their control's label would have, and decorative: each control
// is named by its words. The thumbs on Helpful and Not helpful and the composer's up arrow are Lucide's thumbs-up,
// thumbs-down and arrow-up (ISC license, lucide.dev), as are the message rows' Copy, Check, Pencil and Regenerate
// (Lucide's copy, check, pencil and rotate-cw), the composer's Attach files (Lucide's plus) and a file chip's Remove
// (Lucide's x), and the header's New chat, History and Questions and activity (Lucide's square-pen, history and
// message-circle-question) and a disclosure's chevron (Lucide's chevron-down); Stop is a filled square.

const UP = 'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z';
const DOWN = 'M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z';

function Stroked(props: { color: string; size: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {props.children}
    </Svg>
  );
}

/** The size of every icon in a message's row of actions. */
const ROW = 18;

export function Thumb(props: { down?: boolean; color: string }): React.JSX.Element {
  const down = props.down === true;
  return (
    <Stroked color={props.color} size={ROW}>
      <Path d={down ? 'M17 14V2' : 'M7 10v12'} />
      <Path d={down ? DOWN : UP} />
    </Stroked>
  );
}

export function CopyIcon(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={ROW}>
      <Path d="M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z" />
      <Path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Stroked>
  );
}

export function Check(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={ROW}>
      <Path d="M20 6 9 17l-5-5" />
    </Stroked>
  );
}

export function Pencil(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={ROW}>
      <Path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <Path d="m15 5 4 4" />
    </Stroked>
  );
}

export function Regenerate(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={ROW}>
      <Path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <Path d="M21 3v5h-5" />
    </Stroked>
  );
}

export function ArrowUp(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={20}>
      <Path d="m5 12 7-7 7 7" />
      <Path d="M12 19V5" />
    </Stroked>
  );
}

export function Plus(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={20}>
      <Path d="M5 12h14" />
      <Path d="M12 5v14" />
    </Stroked>
  );
}

/** Lucide's x: a file chip's Remove. */
export function Close(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={16}>
      <Path d="M18 6 6 18" />
      <Path d="m6 6 12 12" />
    </Stroked>
  );
}

export function StopSquare(props: { color: string }): React.JSX.Element {
  return (
    <Svg width={14} height={14} viewBox="0 0 14 14" aria-hidden>
      <Path d="M2 0h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2Z" fill={props.color} />
    </Svg>
  );
}

/** Lucide's maximize-2: the composer's Expand. */
export function Expand(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={18}>
      <Path d="M15 3h6v6" />
      <Path d="M9 21H3v-6" />
      <Path d="m21 3-7 7" />
      <Path d="m3 21 7-7" />
    </Stroked>
  );
}

/** Lucide's minimize-2: the composer's Shrink. */
export function Shrink(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={18}>
      <Path d="M4 14h6v6" />
      <Path d="M20 10h-6V4" />
      <Path d="m14 10 7-7" />
      <Path d="m3 21 7-7" />
    </Stroked>
  );
}

/** The size of the chat header's icons, in their 44px buttons. */
const HEADER = 20;

/** Lucide's square-pen: the header's New chat. */
export function NewChatIcon(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={HEADER}>
      <Path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <Path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
    </Stroked>
  );
}

/** Lucide's history: the header's History. */
export function HistoryIcon(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={HEADER}>
      <Path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <Path d="M3 3v5h5" />
      <Path d="M12 7v5l4 2" />
    </Stroked>
  );
}

/** Lucide's message-circle-question: Questions and activity. */
export function QuestionsIcon(props: { color: string }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={HEADER}>
      <Path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      <Path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <Path d="M12 17h.01" />
    </Stroked>
  );
}

/** Lucide's chevron-down: a disclosure row, turned up while it is open. */
export function ChevronDown(props: { color: string; up?: boolean }): React.JSX.Element {
  return (
    <Stroked color={props.color} size={18}>
      <Path d={props.up === true ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} />
    </Stroked>
  );
}
