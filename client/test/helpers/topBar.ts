import { fireEvent, screen, within } from '@testing-library/react';

// The top bar's More on web (src/portal/shell/TopBar.tsx, D38): Notes, Rules, Town and Your data are drawn only
// while it is open, so a test reaches them by opening it, as a person does.

/** More, in the Main nav. */
export function moreButton(): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'More' });
}

/** Opens More (when it is closed) and gives the box of its links, found by its aria-controls. */
export function openMore(): HTMLElement {
  const more = moreButton();
  if (more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more);
  const box = document.getElementById(more.getAttribute('aria-controls') ?? '');
  if (box === null) throw new Error('More did not open');
  return box;
}
