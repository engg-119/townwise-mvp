import { createContext, useEffect, useRef, type RefObject } from 'react';
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import Head from 'expo-router/head';

import { ThemeToggle } from '../portal/shell/ThemeToggle';
import { Footer } from './Footer.web';
import { EARLY_ACCESS_HREF, navLinks, SIGN_IN_HREF } from './links';
import type { MarketingShellProps } from './MarketingShell';
import { css } from './styles.web';

// The page's scroll container, the root for the observers that reveal parts of a page as they scroll in.
export const ScrollRoot = createContext<RefObject<HTMLElement | null>>({ current: null });

// The web chrome for every marketing page: skip link, header, main and footer, inside one scroll
// container (the export's body does not scroll). The header has the site's light and dark switch (the portal's,
// ThemeToggle) before Sign in. Links are plain anchors; a click on an internal
// one is routed client-side here, and a link to a section (/#how, #cookies) scrolls to it. Each page
// names itself in the document title; Head applies only the focused screen's.
export function MarketingShell(props: MarketingShellProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const hash = useLocalSearchParams()['#'];
  // /request-access sends a signed-out visitor to /sign-in, and one halfway through signing in to /totp, so on
  // those two pages early access is a dead link: neither the header nor the footer offers it there.
  const offerEarlyAccess = pathname !== SIGN_IN_HREF && pathname !== '/totp';

  // Arriving from another page at /#how (or a deep link to /privacy#cookies) lands on the section.
  useEffect(() => {
    if (typeof hash === 'string') showSection(rootRef.current, hash);
  }, [hash]);

  function onClick(event: React.MouseEvent<HTMLDivElement>): void {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    const href = anchor?.getAttribute('href') ?? '';
    if (!href.startsWith('/') && !href.startsWith('#')) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const [path = '', id = ''] = href.split('#');
    if (path !== '' && path !== pathname) {
      router.push(href);
    } else if (id !== '') {
      showSection(rootRef.current, id);
    } else if (rootRef.current !== null) {
      rootRef.current.scrollTop = 0;
    }
  }

  return (
    <div ref={rootRef} className="tw" onClick={onClick}>
      <Head><title>{props.title}</title></Head>
      <style href="townwise-marketing" precedence="default">{css}</style>
      <a className="skip" href="#main">Skip to content</a>
      <header className="nav">
        <div className="wrap nav-in">
          <a className="wm" href="/">Townwise</a>
          <nav className="nav-links" aria-label="Main">
            {navLinks.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}
          </nav>
          <div className="nav-act">
            <ThemeToggle />
            <a className="tl" href={SIGN_IN_HREF} aria-current={pathname === SIGN_IN_HREF ? 'page' : undefined}>Sign in</a>
            {offerEarlyAccess ? <a className="btn" href={EARLY_ACCESS_HREF}>Request early access</a> : null}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}><ScrollRoot value={rootRef}>{props.children}</ScrollRoot></main>
      <Footer root={rootRef} offerEarlyAccess={offerEarlyAccess} />
    </div>
  );
}

// Scrolls without animation and moves focus there, as following an in-page link does. Lookups stay
// inside this page: screens below it in the stack are still mounted.
function showSection(root: HTMLElement | null, id: string): void {
  const target = root?.querySelector<HTMLElement>(`[id="${id}"]`);
  if (target == null) return;
  target.scrollIntoView();
  target.focus({ preventScroll: true });
}
