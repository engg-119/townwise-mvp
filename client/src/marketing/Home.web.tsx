import { useContext, useId, useState } from 'react';

import { homeCss } from './homeStyles.web';
import { HowItWorks } from './HowItWorks.web';
import { EARLY_ACCESS_HREF, SIGN_IN_HREF } from './links';
import { NortheastMap } from './map/NortheastMap.web';
import { towns, type TownKind } from './map/towns';
import { MarketingShell, ScrollRoot } from './MarketingShell.web';
import { useReveal, type RevealView } from './useReveal.web';

// A section shows once its top passes the bottom 12% of the view. With reduced motion it still waits, then
// fades in without moving.
const SECTION_VIEW: RevealView = { threshold: 0, ratio: 0, rootMargin: '0px 0px -12% 0px', showWhenReduced: false };

const FEATURES: readonly { name: string; text: string; planned: boolean }[] = [
  { name: '7-day forecast', text: 'Daily guests for the week ahead, for this week’s orders.', planned: false },
  { name: '28-day forecast', text: 'Daily guests four weeks out, for bigger orders and for planning around the weekends that matter.', planned: false },
  { name: 'A range, not just a number', text: 'Every day gets a low and a high. We check our models on how often the real day lands inside the 80% range.', planned: false },
  { name: 'A reason for every swing', text: 'Each forecast says what is driving it, for example “Commencement weekend”, “Finals week” or “Term ends Friday”.', planned: false },
  { name: 'Next twelve months', text: 'A year-ahead view for the season.', planned: true },
  { name: 'Inventory recommendations', text: 'Reorder points and order quantities.', planned: true },
];

const KINDS: readonly { kind: TownKind; title: string; text: string }[] = [
  { kind: 'college', title: 'College towns.', text: 'Terms, finals, Commencement and homecoming decide your busy weeks.' },
  { kind: 'seasonal', title: 'Seasonal towns.', text: 'The season sets your year: summer on the islands and the Cape, foliage and snow in the mountains.' },
  { kind: 'event', title: 'Event towns.', text: 'Big events bring crowds the regional pattern never shows.' },
];

// A section below the map (ConsoleV2's .sec). It rises in once as it scrolls into view and is never hidden
// without IntersectionObserver. Focus inside it (a section link, Tab) shows it at once, without animating.
function Section(props: { id: string; labelId: string; className?: string; children: React.ReactNode }): React.JSX.Element {
  const root = useContext(ScrollRoot);
  const { ref, armed, revealed, instant, revealNow } = useReveal<HTMLDivElement>(root, SECTION_VIEW);
  const className = ['wrap g12 rv', armed && !revealed ? 'is-hid' : '', instant ? 'is-now' : ''].filter((name) => name !== '').join(' ');
  return (
    <section id={props.id} className={props.className ?? 'sec'} aria-labelledby={props.labelId} tabIndex={-1} onFocus={revealNow}>
      <div ref={ref} className={className}>{props.children}</div>
    </section>
  );
}

// The lead after the map story: the eyebrow, the sub, both actions again and the status line. It rises in
// like a section, and focus inside it (Tab) shows it at once.
function Lead(): React.JSX.Element {
  const root = useContext(ScrollRoot);
  const { ref, armed, revealed, instant, revealNow } = useReveal<HTMLDivElement>(root, SECTION_VIEW);
  const className = ['hd2 rv', armed && !revealed ? 'is-hid' : '', instant ? 'is-now' : ''].filter((name) => name !== '').join(' ');
  return (
    <div ref={ref} className={className} onFocus={revealNow}>
      <p className="eyebrow">Early access. Built at Dartmouth, testing in Hanover, NH.</p>
      <p className="sub">We’re building forecasts of daily guests for restaurants and bars, up to a year ahead, the first three months as a forecast and the rest as a wider outlook, from your town’s calendar, not the region’s.</p>
      <div className="cta-row">
        <a className="btn" href={EARLY_ACCESS_HREF}>Request early access</a>
        <a className="btn-o" href={SIGN_IN_HREF}>Sign in</a>
      </div>
      <p className="eyebrow status">In development. No forecasts are for sale yet.</p>
    </div>
  );
}

// The homepage (ConsoleV2.dc.html). The first screen is the map story's first step: the title, the subtitle and
// both actions over the state outlines. The story follows, then the lead, the town list and panel, then the
// sections in the mockup's order. Heading ids carry a useId prefix: screens stay mounted in the stack, and other
// pages use h-hero and h-about.
export default function Home(): React.JSX.Element {
  const id = useId();
  // The title rises once and the subtitle fades in after it. Each animation is dropped when it ends, because
  // the stack hides this screen with display: none, which would replay it on the way back.
  const [risen, setRisen] = useState(false);
  const [subIn, setSubIn] = useState(true);
  const h = (name: string): string => `${id}h-${name}`;
  const head = (
    <div className="hd">
      <h1 id={h('hero')} className={risen ? 'h1' : 'h1 is-rise'}>
        <span className="ln"><span><span className="w">The Northeast</span> <span className="w">has one season.</span></span></span>
        {' '}
        <span className="ln"><span onAnimationEnd={() => { setRisen(true); }}><span className="w">Your town</span> <span className="w">has its own.</span></span></span>
      </h1>
      <p className={subIn ? 'hsub is-in' : 'hsub'} onAnimationEnd={() => { setSubIn(false); }}>
        We’re building daily demand forecasts for restaurants and bars in college, ski and island towns. <span className="hsub-2">Now in early access.</span>
      </p>
      <div className="cta-row">
        <a className="btn" href={EARLY_ACCESS_HREF}>Request early access</a>
        <a className="btn-o" href={SIGN_IN_HREF}>Sign in</a>
      </div>
    </div>
  );
  return (
    <MarketingShell title="Townwise">
      <style href="townwise-home" precedence="default">{homeCss}</style>
      <div className="pg-home">
        <section id="map" className="hero" aria-labelledby={h('hero')} tabIndex={-1}>
          <div className="wrap">
            <NortheastMap head={head} lead={<Lead />} />
          </div>
        </section>

        <Section id="problem" labelId={h('problem')}>
          <p className="eyebrow c-l">The problem</p>
          <h2 id={h('problem')} className="h2 c-r">A regional forecast averages your town away.</h2>
          <ol className="probs c-r">
            <li><h3 className="h3">Your calendar is local.</h3><p className="body">A college term, a ski season or a summer on the Cape moves demand in your town on its own schedule, whatever the region is doing.</p></li>
            <li><h3 className="h3">Regional patterns can’t see it.</h3><p className="body">A forecast built from regional demand has no way to know that this Saturday is Commencement, or that the cruise ship is in.</p></li>
            <li><h3 className="h3">You pay for the gap.</h3><p className="body">Order to a regional forecast and you run short on the big weekends and sit on stock in the quiet ones. Staff to it and you are thin exactly when it counts.</p></li>
          </ol>
        </Section>

        <Section id="how" labelId={h('how')}>
          <p className="eyebrow c-l">How it works</p>
          <h2 id={h('how')} className="h2 c-r">Local first. Then your own numbers.</h2>
          <HowItWorks />
          <p className="after body c-r">Forecasts we report as results are frozen before their outcomes are known, then scored afterward. Tests on past data are labeled as backtests.</p>
        </Section>

        <Section id="product" labelId={h('product')}>
          <p className="eyebrow c-l">What you get</p>
          <div className="c-r lead-l">
            <h2 id={h('product')} className="h2">Two horizons. A range. A reason.</h2>
            <p className="eyebrow">In development. None of this is available to restaurants yet.</p>
          </div>
          <div className="c-r">
            <ul className="feat">
              {FEATURES.map((feature) => (
                <li key={feature.name}>
                  <span className="fn">{feature.name}</span>
                  <span className="fd">{feature.text}</span>
                  {feature.planned ? <span className="tag tag-plan">Planned</span> : <span className="tag tag-prog">In progress</span>}
                </li>
              ))}
            </ul>
            <div className="ill">
              <p className="eyebrow ill-h">Illustrative layout, not real output</p>
              <p className="ill-row">
                <span><span className="slot">{'{weekday}'}</span><span className="slot">{'{date}'}</span></span>
                <span><span className="slot">{'{guests}'}</span>guests</span>
                <span>range<span className="slot">{'{low}'}</span>to<span className="slot">{'{high}'}</span></span>
                <span><span className="slot">{'{sales}'}</span>sales</span>
                <span><span className="slot">{'{reason}'}</span></span>
              </p>
            </div>
          </div>
        </Section>

        <Section id="who" labelId={h('who')}>
          <p className="eyebrow c-l">Who it is for</p>
          <h2 id={h('who')} className="h2 c-r">Independent restaurants and bars in towns that keep their own calendar.</h2>
          <div className="c-r">
            <ul className="who">
              {KINDS.map((kind) => (
                <li key={kind.kind}>
                  <h3 className="h3">{kind.title}</h3>
                  <p className="body">{kind.text}</p>
                  <ul className="twl">
                    {towns.filter((town) => town.kind === kind.kind).map((town) => <li key={town.id}>{town.name}, {town.state}</li>)}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="who-foot">
              <p className="big">For the person who places the orders.</p>
              <p className="body">If your demand already follows the region, a regional forecast may be all you need.</p>
              <a className="btn" href={EARLY_ACCESS_HREF}>Request early access</a>
            </div>
          </div>
        </Section>

        <Section id="about" className="sec about" labelId={h('about')}>
          <h2 id={h('about')} className="eyebrow c-l">
            <a href="/about">
              About
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                <path d="M2 10 L10 2 M4 2 H10 V8" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </a>
          </h2>
          <p className="h3 c-r">Built by students in ENGG 119, AI in the Real World, at Dartmouth’s Thayer School of Engineering in Hanover, NH.</p>
        </Section>

        <Section id="faq" labelId={h('faq')}>
          <h2 id={h('faq')} className="eyebrow c-l">FAQ</h2>
          <div className="faq c-r">
            <div className="faq-i">
              <h3 className="h3">How is this different from my point-of-sale system’s forecast?</h3>
              <p>If your system forecasts from regional demand patterns, it sees the region, not your town. Townwise starts from your town: a research agent will find the local events that move demand, then your own sales history will calibrate the model to your business, and you will be able to tune it by talking to it. The question we are testing is whether that local model beats a general one, especially where sales history is thin.</p>
            </div>
            <div className="faq-i">
              <h3 className="h3">What data do I need to give you?</h3>
              <p>Your daily guest counts and net sales, from a CSV export of your point-of-sale system. Once you have access, you drop your files in the app, and we store them privately for your organization and read the date, guest count and net sales for each day. Or your browser can read a CSV and send us only those three values a day, without the file. Townwise is designed to start from public local information and improve as your history comes in, and we are testing how much history it takes to make a real difference.</p>
            </div>
            <div className="faq-i">
              <h3 className="h3">Is my sales data shared, or used to train forecasts for other restaurants?</h3>
              <p>No. Your sales data is used only to provide Townwise to your restaurant: its own forecasts and TownwiseAI, its AI assistant. It is not shared with or used for other restaurants, and it is not used to train AI models. In the app, the people on your organization’s team can see it. Townwise staff can see the figures only through a read-only view that is recorded and shown to your organization’s admins, or by opening your organization as its admin with your consent, which needs a reason once anyone from it has joined and is recorded and shown to your admins too. The <a href="/privacy">Privacy notice</a> has the details.</p>
            </div>
            <div className="faq-i">
              <h3 className="h3">Which towns do you cover?</h3>
              <p>We are building and testing in Hanover, NH first. The other towns on the map show the kinds of places Townwise is built for. If your town keeps its own calendar, tell us about it.</p>
            </div>
            <div className="faq-i">
              <h3 className="h3">How accurate is it?</h3>
              <p>We are not publishing an accuracy number yet. Forecasts we report as results are frozen before their outcomes are known, so any accuracy we publish on live forecasts comes from forecasts frozen in advance. Tests on past data will be labeled as backtests.</p>
            </div>
            <div className="faq-i">
              <h3 className="h3">What does it cost?</h3>
              <p>Townwise does not charge for early access. Pricing is not set yet.</p>
            </div>
            <div className="faq-i">
              <h3 className="h3">Is Townwise ready to use today?</h3>
              {/* [CONFIRM: wording, awaiting the owner] Forecasts publish by default and refit weekly (autonomous-forecasts, D42). */}
              <p>Yes, in early access, though the forecasts are still being tested. Townwise is a student project in active development. With early access you can add your locations, upload your sales history, add notes about unusual days and see your town’s public profile, if it is one of the twelve on the map. Once a location’s sales history spans 230 days, Townwise forecasts its daily guests, refits the forecast every week, and says whether its trained model or a simpler baseline made it.</p>
            </div>
          </div>
        </Section>

        <Section id="start" className="sec fin" labelId={h('start')}>
          <h2 id={h('start')} className="h2 fin-l">Tell us about your town.</h2>
          <div className="fin-r">
            <p className="body">Townwise is in early access. Sign in with Google and fill in a short form about your restaurant and your town. Someone on our team reviews each request by hand.</p>
            <a className="btn" href={EARLY_ACCESS_HREF}>Request early access</a>
            <a className="tl" href={SIGN_IN_HREF}>Already have access? Sign in</a>
          </div>
        </Section>
      </div>
    </MarketingShell>
  );
}
