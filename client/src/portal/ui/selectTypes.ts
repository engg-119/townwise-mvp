import type { SelectGroup, SelectOption } from '../towns';
import type { FieldChrome } from './FormField';

export type { SelectGroup, SelectOption };

export interface SelectProps extends FieldChrome {
  value: string;
  onChange: (value: string) => void;
  /** Options, or labelled groups of options, in order. */
  items: readonly (SelectOption | SelectGroup)[];
  /** A first, empty choice ("Choose a town"), with the value ''. */
  placeholder?: string;
  /** The location switcher: at most 280px wide. */
  compact?: boolean;
  /** When it appears, focus the control (web) or move the screen reader to it (native): places/focus.ts. */
  autoFocus?: boolean;
}

export function isGroup(item: SelectOption | SelectGroup): item is SelectGroup {
  return 'options' in item;
}

export function labelOf(items: SelectProps['items'], value: string): string | null {
  for (const item of items) {
    if (isGroup(item)) {
      const found = item.options.find((option) => option.value === value);
      if (found !== undefined) return found.label;
    } else if (item.value === value) {
      return item.label;
    }
  }
  return null;
}
