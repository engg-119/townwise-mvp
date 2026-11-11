import { fireEvent, within } from '@testing-library/react';

// Drives the portal's select on web (src/portal/ui/Select.web.tsx): a select-only combobox whose list is drawn on
// the page's body only while it is open, so its choices are read and picked by opening it, as a person does.

/** The open list of a select. */
export function listOf(combobox: HTMLElement): HTMLElement {
  const id = combobox.getAttribute('aria-controls');
  const list = id === null ? null : document.getElementById(id);
  if (list === null) throw new Error('The select is closed.');
  return list;
}

function opened(combobox: HTMLElement): HTMLElement {
  if (combobox.getAttribute('aria-expanded') !== 'true') fireEvent.click(combobox);
  return listOf(combobox);
}

/** The select's choices' labels in order, the placeholder first; the select is left closed. */
export function choicesOf(combobox: HTMLElement): string[] {
  const labels = within(opened(combobox)).getAllByRole('option').map((option) => option.textContent);
  fireEvent.keyDown(combobox, { key: 'Escape' });
  return labels;
}

/** The select's group labels in order; the select is left closed. */
export function groupsOf(combobox: HTMLElement): string[] {
  const list = opened(combobox);
  const labels = within(list).getAllByRole('group').map((group) => {
    const id = group.getAttribute('aria-labelledby');
    return (id === null ? null : document.getElementById(id)?.textContent) ?? '';
  });
  fireEvent.keyDown(combobox, { key: 'Escape' });
  return labels;
}

/** Picks the choice with this label with the mouse, opening the select first. */
export function choose(combobox: HTMLElement, label: string): void {
  fireEvent.click(within(opened(combobox)).getByRole('option', { name: label }));
}

/** The label the closed select shows: its choice, or its placeholder. */
export function shownChoice(combobox: HTMLElement): string {
  return combobox.textContent;
}
