import { useContext, useEffect, useId, useRef, useState } from 'react';

import { MONTHS } from './map/countyData';
import { fmtRange } from './map/TownPanel.web';
import { towns } from './map/towns';
import { FLOW, FLOW_DAY_PX } from './homeStyles.web';
import { ScrollRoot } from './MarketingShell.web';
import { SourceChips } from './SourceChip.web';
import { useMediaQuery } from './useReducedMotion.web';
import { useReveal, type RevealView } from './useReveal.web';

// Step 01 shows Hanover's dates from the published calendars, with one source chip per source page.
const HANOVER_DATES = towns.find((town) => town.id === 'hanover-nh')?.dates ?? [];
const HANOVER_SOURCES = [...new Set(HANOVER_DATES.flatMap((date) => date.sourceUrls))].map((url) => ({ url }));

// The illustrations of steps 02 and 03 (ConsoleV2.dc.html), in a 400 by 200 box. Not real output.
const GRID_D = 'M0 40 H400 M0 100 H400 M0 160 H400';
const BAND_D = 'M16.0 141.8 L29.6 136.7 L43.3 127.0 L56.9 108.1 L70.5 70.8 L84.1 56.5 L97.8 97.4 L111.4 138.3 L125.0 133.2 L138.7 123.5 L152.3 104.6 L165.9 67.3 L179.6 53.0 L193.2 93.9 L206.8 134.8 L220.4 129.7 L234.1 120.0 L247.7 101.1 L261.3 41.8 L275.0 27.5 L288.6 90.4 L302.2 131.3 L315.9 126.2 L329.5 116.5 L343.1 97.6 L356.7 60.3 L370.4 46.0 L384.0 86.9 L384.0 127.9 L370.4 86.0 L356.7 99.3 L343.1 135.6 L329.5 153.5 L315.9 162.2 L302.2 166.3 L288.6 124.4 L275.0 60.5 L261.3 73.8 L247.7 132.1 L234.1 150.0 L220.4 158.7 L206.8 162.8 L193.2 120.9 L179.6 79.0 L165.9 92.3 L152.3 128.6 L138.7 146.5 L125.0 155.2 L111.4 159.3 L97.8 117.4 L84.1 75.5 L70.5 88.8 L56.9 125.1 L43.3 143.0 L29.6 151.7 L16.0 155.8 Z';
const GUESTS_D = 'M16.0 148.8 L29.6 144.2 L43.3 135.0 L56.9 116.6 L70.5 79.8 L84.1 66.0 L97.8 107.4 L111.4 148.8 L125.0 144.2 L138.7 135.0 L152.3 116.6 L165.9 79.8 L179.6 66.0 L193.2 107.4 L206.8 148.8 L220.4 144.2 L234.1 135.0 L247.7 116.6 L261.3 57.8 L275.0 44.0 L288.6 107.4 L302.2 148.8 L315.9 144.2 L329.5 135.0 L343.1 116.6 L356.7 79.8 L370.4 66.0 L384.0 107.4';
const METHODS = ['quantile regression', 'event model', 'gradient-boosted trees', 'rolling backtest'];

// Step 03: the town model's daily guests, quiet weeks and event weeks, over 40 days (28 in view and the 12 the live
// phase brings in), and the actual guests every other day: history to day 20 (today), then the six that land at the
// today line as the chart moves on (homeStyles' FLOW).
const dayX = (day: number): number => 16 + day * FLOW_DAY_PX;
const QUIET_WEEK = [147.4, 142.1, 131.6, 110.4, 68.1, 52.2, 99.8];
const EVENT_WEEK = [147.4, 142.1, 131.6, 110.4, 46.1, 30.2, 99.8];
const MODEL = [QUIET_WEEK, EVENT_WEEK, QUIET_WEEK, QUIET_WEEK, EVENT_WEEK, QUIET_WEEK].flat().slice(0, 28 + FLOW.steps * FLOW.daysPerStep);
const MODEL_D = MODEL.map((y, day) => `${day === 0 ? 'M' : 'L'}${dayX(day).toFixed(1)} ${y.toFixed(1)}`).join(' ');
const TODAY = 20;
const ACTUAL = [152.4, 134.6, 70.1, 96.8, 137.1, 108.4, 26.2, 141.4, 132.6, 74.1, 101.8, 147.1, 113.4, 56.2, 151.0, 126.0, 39.5];
const HISTORY = ACTUAL.slice(0, TODAY / 2 + 1);
const LANDING = ACTUAL.slice(TODAY / 2 + 1);

const STEPS = [0, 1, 2, 3];
// The pinned stage needs two columns' width (and an observer for the active step).
const WIDE = '(min-width: 1024px)';
// The window's center band: the step inside it is the active one.
const BAND = '-45% 0px -45% 0px';
// A visual plays its enter once half of it is in view. A 0.5 threshold also reports the first pixel of
// overlap, so the ratio decides.
const VISUAL_VIEW: RevealView = { threshold: 0.5, ratio: 0.49, rootMargin: '0px', showWhenReduced: false };

function stepNo(index: number): string {
  return `0${index + 1}`;
}

// A part's place in its visual's stagger, read by its transition delay.
function nth(n: number): React.CSSProperties {
  return { '--n': n } as React.CSSProperties;
}

// Step 03: your history and the fitted model, the today line and the forecast ahead (dashed). Then the live phase
// moves the chart on and each new actual lands at the today line beside what the model predicted. The clip paths
// stay put while the groups inside them move, so the solid line is always the past and the dashed one the forecast.
function LiveFit(): React.JSX.Element {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const today = dayX(TODAY);
  return (
    <>
      <p className="hv-k">Your history and the town model</p>
      <svg className="v-ch" viewBox="0 0 400 200" focusable="false">
        <defs>
          <clipPath id={`${id}view`}><rect x="8" y="0" width="384" height="200" /></clipPath>
          <clipPath id={`${id}past`}><rect x="0" y="0" width={today} height="200" /></clipPath>
          <clipPath id={`${id}ahead`}><rect x={today} y="0" width={400 - today} height="200" /></clipPath>
        </defs>
        <path className="v-grid" d={GRID_D} />
        <g clipPath={`url(#${id}view)`}>
          <g clipPath={`url(#${id}past)`}><g className="v3-flow"><path className="v3-line" d={MODEL_D} /></g></g>
          <g clipPath={`url(#${id}ahead)`}><g className="v3-flow"><path className="v3-fc" d={MODEL_D} strokeDasharray="4 4" /></g></g>
          <g className="v3-flow">
            {HISTORY.map((cy, n) => <circle key={n} className="v3-dot" cx={dayX(2 * n).toFixed(1)} cy={cy} r="4" style={nth(n)} />)}
            {LANDING.map((cy, k) => <circle key={k} className="v3-new" cx={dayX(TODAY + FLOW.daysPerStep * (k + 1)).toFixed(1)} cy={cy} r="4" style={{ '--k': k } as React.CSSProperties} />)}
          </g>
        </g>
        <line className="v3-today" x1={today.toFixed(1)} x2={today.toFixed(1)} y1="16" y2="184" />
      </svg>
      <ul className="v3-lg">
        <li><span className="v3-sw v3-sw-a" />Actual</li>
        <li><span className="v3-sw v3-sw-p" />Predicted</li>
        <li><span className="v3-sw v3-sw-f" />Forecast</li>
        <li><span className="v3-sw v3-sw-t" />Today</li>
      </ul>
      <p className="hv-cap">Illustration, not real output</p>
    </>
  );
}

// The illustration of step `index` (ConsoleV2's stage visuals). Decorative: the step's text carries the
// meaning, and step 01 also lists its dates for screen readers.
function Visual(props: { index: number }): React.JSX.Element {
  if (props.index === 0) {
    return (
      <>
        <ul className="v1-l">
          {HANOVER_DATES.map((date, n) => {
            const [year = '', month = '', day = ''] = date.start.split('-');
            return (
              <li key={date.text} style={nth(n)}>
                <span className="v1-d"><span className="v1-m">{MONTHS[Number(month) - 1]} {year}</span><span className="v1-dd">{Number(day)}</span></span>
                <span className="v1-t">{date.text}</span>
              </li>
            );
          })}
        </ul>
        <p className="hv-cap">Hanover, NH. Dates from public calendars.</p>
      </>
    );
  }
  if (props.index === 1) {
    return (
      <>
        <p className="hv-k">Daily guests, next 28 days</p>
        <svg className="v-ch" viewBox="0 0 400 200" focusable="false">
          <path className="v-grid" d={GRID_D} />
          <path className="v2-band" d={BAND_D} />
          <path className="v2-line" pathLength={1} d={GUESTS_D} />
        </svg>
        <ul className="v2-tags">{METHODS.map((method, n) => <li key={method} style={nth(n)}>{method}</li>)}</ul>
        <p className="hv-cap">Illustration, not real output</p>
      </>
    );
  }
  if (props.index === 2) return <LiveFit />;
  return (
    <>
      <p className="hv-k">Orders for the week of <span className="slot">{'{date}'}</span></p>
      <ul className="v4-l">
        {[0, 1, 2].map((row) => (
          <li key={row} className="v4-r" style={nth(row)}>
            <span className="slot">{'{item}'}</span><span>order</span><span className="slot">{'{quantity}'}</span>
            <span>by</span><span className="slot">{'{weekday}'}</span><span className="slot">{'{reason}'}</span>
          </li>
        ))}
      </ul>
      <p className="hv-cap">Planned. Illustration.</p>
    </>
  );
}

// Under 1024px, or without an observer: the step's illustration under its text. It plays its enter once,
// when half of it is in view; without IntersectionObserver it shows as is.
function InlineVisual(props: { index: number }): React.JSX.Element {
  const root = useContext(ScrollRoot);
  const { ref, revealed } = useReveal<HTMLDivElement>(root, VISUAL_VIEW);
  return (
    <div ref={ref} className={revealed ? 'hv hv-in is-on' : 'hv hv-in'} aria-hidden="true">
      <Visual index={props.index} />
    </div>
  );
}

// From 1024px with an observer: one stage pinned beside the steps, centered in the scroll container (the
// header does not stick), released when the steps end. Once half of it has been in view it
// shows the active step's illustration; on a change the outgoing one fades out as the next plays its enter.
// Decorative: hidden from assistive technology, with nothing focusable inside.
function Stage(props: { active: number }): React.JSX.Element {
  const root = useContext(ScrollRoot);
  const { ref, revealed } = useReveal<HTMLDivElement>(root, VISUAL_VIEW);
  return (
    <div className="hw-stc" aria-hidden="true">
      <div ref={ref} className="hw-st">
        <div className="hw-hd">
          <ol className="hw-pg">
            {STEPS.map((index) => <li key={index} className={index === props.active ? 'is-cur' : undefined}>{stepNo(index)}</li>)}
          </ol>
        </div>
        <div className="hw-vz">
          {STEPS.map((index) => (
            <div key={index} className={revealed && index === props.active ? 'hv is-on' : 'hv'}><Visual index={index} /></div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Step(props: { index: number; active: boolean; inline: boolean; planned?: boolean; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <li className={props.active ? 'hw-s is-act' : 'hw-s'}>
      <div className="step">
        <div className="step-bar">
          <span className="step-no">{stepNo(props.index)}</span>
          {props.planned === true ? <span className="tag tag-plan">Planned</span> : <span className="tag tag-prog">In progress</span>}
        </div>
        <div className="step-body">
          <h3 className="h3">{props.title}</h3>
          {props.children}
        </div>
      </div>
      {props.inline ? <InlineVisual index={props.index} /> : null}
    </li>
  );
}

// How it works (ConsoleV2's #how). From 1024px with IntersectionObserver the steps scroll on the left in
// 560px slots beside the pinned stage. Under 1024px, or without an observer, they stack, each with its
// illustration under its text.
export function HowItWorks(): React.JSX.Element {
  const root = useContext(ScrollRoot);
  const list = useRef<HTMLOListElement>(null);
  const [observable] = useState(() => typeof IntersectionObserver === 'function');
  const pinned = useMediaQuery(WIDE) && observable;
  const [active, setActive] = useState(0);

  // The step in the center band is the active one. It starts at step 01 and changes only when exactly one
  // step is in the band. Native scroll only: no scroll or wheel listener, no snapping.
  useEffect(() => {
    if (!pinned || list.current === null) return undefined;
    const slots = Array.from(list.current.children);
    const inBand = slots.map(() => false);
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) inBand[slots.indexOf(entry.target)] = entry.isIntersecting;
      const [only, ...more] = inBand.flatMap((inside, index) => (inside ? [index] : []));
      if (only !== undefined && more.length === 0) setActive(only);
    }, { root: root.current, threshold: 0, rootMargin: BAND });
    for (const slot of slots) observer.observe(slot);
    return () => { observer.disconnect(); };
  }, [pinned, root]);

  const isActive = (index: number): boolean => pinned && index === active;
  return (
    <div className={pinned ? 'hw is-pin' : 'hw'}>
      <ol ref={list} className="steps">
        <Step index={0} active={isActive(0)} inline={!pinned} title="Research the town">
          <p>A research agent will work out what moves demand in your town: the academic calendar, sporting events, campus activities, tourism and seasonal population changes. It will gather the public dates behind each one into a profile of the town.</p>
          <p><span className="lbl">Today:</span> Hanover’s calendar is compiled from public sources, every date with a source. The agent that will do this research on its own is not built yet.</p>
          <ul className="sr-only">{HANOVER_DATES.map((date) => <li key={date.text}>{date.text}, {fmtRange(date.start, date.end)}</li>)}</ul>
          <p className="hw-src">Source:<SourceChips sources={HANOVER_SOURCES} /></p>
        </Step>
        <Step index={1} active={isActive(1)} inline={!pinned} title="Build the forecast">
          <p>A forecasting agent will turn the town profile into model inputs, choose modeling approaches, then train, test and refine the models itself.</p>
          <p><span className="lbl">Today:</span> candidate models run in our research notebooks, including quantile regression, an event model and gradient-boosted trees, tested with a rolling backtest. The agent that will build and refine models on its own is not built yet.</p>
        </Step>
        <Step index={2} active={isActive(2)} inline={!pinned} title="Calibrate with your sales">
          <p>Your point-of-sale history will tune the town model to your restaurant, and the forecast is designed to get sharper as more history comes in. We are testing how much history it takes to make a difference.</p>
          <p><span className="lbl">Today:</span> restaurants with early access upload their daily guests and net sales in the web app, and add notes about closures and other unusual days. Calibration itself is not built yet, so the app shows no forecasts.</p>
        </Step>
        <Step index={3} active={isActive(3)} inline={!pinned} planned title="Turn the forecast into orders">
          <p>Plain-language recommendations for when to reorder and how much, starting with bar and drink inventory.</p>
        </Step>
      </ol>
      {pinned ? <Stage active={active} /> : null}
    </div>
  );
}
