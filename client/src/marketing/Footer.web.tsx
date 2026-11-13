import { useId, type RefObject } from 'react';

import { EARLY_ACCESS_HREF, footerGroups } from './links';
import { useReveal, type RevealView } from './useReveal.web';

// TOWNWISE rises letter by letter from the center out, each delay step 50ms apart.
const LETTERS = [['T', 3], ['O', 2], ['W', 1], ['N', 0], ['W', 0], ['I', 1], ['S', 2], ['E', 3]] as const;
const STEP_MS = 50;
// A quarter of the footer in view above the bottom 5% (a ratio of 0.2 allows for rounding). The letters only
// move, so reduced motion shows them at once.
const FOOTER_VIEW: RevealView = { threshold: 0.25, ratio: 0.2, rootMargin: '0px 0px -5% 0px', showWhenReduced: true };

// offerEarlyAccess is false on /sign-in (MarketingShell.web), where the Request early access link would lead back.
export function Footer(props: { root: RefObject<HTMLElement | null>; offerEarlyAccess?: boolean }): React.JSX.Element {
  const { ref, armed, revealed, instant, revealNow } = useReveal<HTMLElement>(props.root, FOOTER_VIEW);
  const id = useId();
  const className = ['ft', armed ? 'is-armed' : '', revealed ? 'is-in' : '', instant ? 'is-now' : '']
    .filter((name) => name !== '')
    .join(' ');
  return (
    <footer ref={ref} className={className} onFocus={revealNow}>
      <div className="wrap ft-inner">
        <div className="g12 ft-cols">
          <div className="ft-c1">
            <a className="wm" href="/">Townwise</a>
            <p className="ft-by">Built by students in ENGG 119, AI in the Real World, at Dartmouth’s Thayer School of Engineering in Hanover, NH.</p>
          </div>
          {footerGroups.map((group) => (
            <nav key={group.title} className="ft-cn" aria-labelledby={`${id}${group.title}`}>
              <h2 id={`${id}${group.title}`} className="eyebrow">{group.title}</h2>
              <ul>
                {group.links
                  .filter((link) => props.offerEarlyAccess !== false || link.href !== EARLY_ACCESS_HREF)
                  .map((link) => <li key={link.label}><a href={link.href}>{link.label}</a></li>)}
              </ul>
            </nav>
          ))}
        </div>
        <div className="ft-bot">
          <p>© 2026 Townwise</p>
          <p>Townwise is a student project. It is not an official Dartmouth product.</p>
        </div>
        <div className="ft-word" aria-hidden="true">
          {LETTERS.map(([letter, step], index) => (
            <span key={index} style={{ transitionDelay: `${step * STEP_MS}ms` }}>{letter}</span>
          ))}
        </div>
      </div>
    </footer>
  );
}
