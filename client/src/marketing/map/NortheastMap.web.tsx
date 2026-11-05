import { useCallback, useContext, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react';

import { fmt1, fmtSigned } from '../format';
import { ScrollRoot } from '../MarketingShell.web';
import { useMediaQuery, useReducedMotion } from '../useReducedMotion.web';
import { bandEdges, CENTER_BAND, phoneBand, rootMargin, sideOf, sideOfRect, type Band, type Side } from './band';
import { cameraFor, cameraPoint, cameraTransform, REGION } from './camera';
import { DATA_YEAR, GROUP_DOMAIN, MAX_ABS_GAP, MONTHS, northeastSeries, type TownGroup } from './countyData';
import { FEATURED_D, stateShapes, STATES_D, VIEW_HEIGHT, VIEW_WIDTH, type Point } from './geometry';
import {
  FINAL_STEP, initialMapState, mapReducer, mapTowns, markerScale, MONTH_NAMES, monthLabel, nearestTown, PATTERN_LABEL, patternGap,
  PATTERNS, shownMonth, valueAt, type MapTown,
} from './mapState';
import { mapCss } from './mapStyles.web';
import { cursorX, finale, flowOf, glyphOf, moveAt, moveSentence, NE_SPARK_D, PIN_EXTRA, placeTags, railFill, storyBox, titleBox } from './story';
import { storyCss } from './storyStyles.web';
import { TownPanel } from './TownPanel.web';

// The intro: the outlines start drawing once the hero title has mostly landed (450ms from mount, or a frame
// after the map comes into view), then draw for 900ms.
const TITLE_MS = 450;
const DRAW_MS = 900;
const WATCHDOG_MS = 1000;
const WIDE = '(min-width: 1024px)';
const FINALE = finale();

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

// A map point as a position in the HTML overlay, which spans the viewBox.
function place([x, y]: Point): { left: string; top: string } {
  return { left: `${round((x * 100) / VIEW_WIDTH, 3)}%`, top: `${round((y * 100) / VIEW_HEIGHT, 3)}%` };
}

// The draw-in dash, in user units: one dash as long as the longest outline (each subpath restarts the dash)
// and a gap as long as all of them, so an outline is hidden at offset `longest` and whole at 0.
function dashFor(d: string): { longest: number; total: number } {
  const lengths = d.split(/(?=M)/).map((outline) => {
    const points = [...outline.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => [Number(match[1]), Number(match[2])] as const);
    if (/Z\s*$/.test(outline) && points[0] !== undefined) points.push(points[0]);
    let length = 0;
    points.forEach(([x, y], index) => {
      const previous = points[index - 1];
      if (previous !== undefined) length += Math.hypot(x - previous[0], y - previous[1]);
    });
    return length;
  });
  return { longest: Math.ceil(Math.max(...lengths)) + 1, total: Math.ceil(lengths.reduce((sum, length) => sum + length, 0)) + 1 };
}

const DASH = dashFor(STATES_D);
const RI = stateShapes.find((state) => state.leaderTo !== null);
const LEAD_D = RI?.leaderTo == null ? '' : `M${RI.leaderTo[0]} ${RI.leaderTo[1]} V${round(RI.label[1] - 25, 1)}`;
// Markers enter west to east.
const WEST = [...mapTowns].sort((a, b) => a.shape.centroid[0] - b.shape.centroid[0]).map((town) => town.id);
const GROUPS: readonly { group: TownGroup; title: string }[] = [
  { group: 'college', title: 'College' },
  { group: 'seasonalEvent', title: 'Seasonal and event' },
];
// Every list value has the width of the largest, so the months and decimal points line up.
const VALUE_WIDTH = fmtSigned(MAX_ABS_GAP).length;

function spark(values: readonly number[], [lo, hi]: readonly [number, number]): string {
  return values.map((value, month) => `${month === 0 ? 'M' : 'L'}${round(1 + (month * 62) / 11, 2)} ${round(19 - ((value - lo) / (hi - lo)) * 18, 2)}`).join(' ');
}

// Two copies of each crossfade class, flipped on every change, so the animation replays.
function flip(prefix: string, tick: number): string {
  if (tick === 0) return '';
  return tick % 2 === 1 ? `${prefix}-a` : `${prefix}-b`;
}

function classes(...names: (string | false)[]): string {
  return names.filter((name) => name !== false && name !== '').join(' ');
}

// A step slot's row in the wide story grid.
function row(n: number): React.CSSProperties {
  return { '--row': n } as React.CSSProperties;
}

// The month rail: months before the shown one are past, the shown one is current.
function railClass(index: number, month: number): string | undefined {
  if (index < month) return 'is-p';
  return index === month ? 'is-c' : undefined;
}

// What the moving dots mean, and with reduced motion the + and − that replace them (CSS shows one).
const FLOW_MOTION = 'Dots pulling in: restaurant and bar jobs up since last month, compared with the Northeast. Pushing out: down.';
const FLOW_GLYPHS = '+ or − beside a dot: restaurant and bar jobs up or down since last month, compared with the Northeast.';

function Legend(props: { className: string }): React.JSX.Element {
  return (
    <div className={props.className}>
      <ul className="lg-pat">
        {PATTERNS.map((pattern) => <li key={pattern}><span className={`sw sw-${pattern}`} aria-hidden="true" />{PATTERN_LABEL[pattern]}</li>)}
      </ul>
      <p>Dot size: that month’s gap from the Northeast, index points</p>
      <ul>
        <li><span className="sw sw-sz s-lo" aria-hidden="true" />0</li>
        <li><span className="sw sw-sz s-hi" aria-hidden="true" />{fmt1(MAX_ABS_GAP)}</li>
      </ul>
      <p>Dashed outline: the town’s county</p>
      <p className="lg-fl"><span className="lg-fl-m">{FLOW_MOTION}</span><span className="lg-fl-r">{FLOW_GLYPHS}</span></p>
    </div>
  );
}

// What the story measures: the pinned map's width and the story's and window's (value tags are placed in the
// map, clear of the title when it reaches over the flat map), and the band.
interface Fit {
  mw: number;
  width: number;
  windowWidth: number;
  band: Band;
}

interface StoryParts {
  story: HTMLElement;
  pin: HTMLElement;
  fig: HTMLElement;
  box: HTMLElement;
  cap: HTMLElement;
}

// Sizes the pinned map from the story's width and the scroll container's height, in px, and writes them as the
// story's custom properties before the browser paints. From 1024px the legend and caption under the map are
// measured too: when they are taller than budgeted the map shrinks, so the whole block still fits the window,
// centered, and the month panel's box (the same height) stays centered with it. Under 1024px the band is set
// below the pinned map. A hidden screen measures 0 and changes nothing.
function fitStory(parts: StoryParts, root: HTMLElement | null, wide: boolean): Fit | null {
  const width = parts.story.clientWidth;
  const height = root === null ? window.innerHeight : root.clientHeight;
  if (width <= 0 || height <= 0) return null;
  const apply = (extra: number): { mw: number } => {
    const box = storyBox(width, height, wide, extra);
    parts.story.style.setProperty('--story-mw', `${String(box.mw)}px`);
    parts.story.style.setProperty('--story-mh', `${String(box.mh)}px`);
    parts.story.style.setProperty('--story-top', `${String(box.top)}px`);
    parts.story.style.setProperty('--story-ex', `${String(extra)}px`);
    return box;
  };
  let extra = PIN_EXTRA;
  let box = apply(extra);
  for (let pass = 0; wide && pass < 3; pass += 1) {
    const measured = Math.max(PIN_EXTRA, Math.ceil(parts.fig.offsetHeight - parts.box.offsetHeight + parts.cap.offsetHeight));
    if (measured === extra) break;
    extra = measured;
    box = apply(extra);
  }
  return { mw: box.mw, width, windowWidth: window.innerWidth, band: wide ? CENTER_BAND : phoneBand(height, parts.pin.offsetHeight) };
}

function sameFit(a: Fit, b: Fit): boolean {
  return a.mw === b.mw && a.width === b.width && a.windowWidth === b.windowWidth && a.band.top === b.band.top && a.band.bottom === b.band.bottom && a.band.unit === b.band.unit;
}

// The homepage map (ConsoleV2.dc.html) as a scroll-driven story: the title over the state outlines, the region,
// then the twelve towns month by month, January to December, and back to the month of the widest spread. The
// scroll is the only clock; nothing moves on its own. Under the story come the lead (`lead`), the town list (the
// keyboard and screen-reader control; markers are aria-hidden and out of the tab order) and the chosen town's panel.
// Without IntersectionObserver the map lies flat at that month, the step texts in a row under it.
export function NortheastMap(props: { head?: React.ReactNode; lead?: React.ReactNode }): React.JSX.Element {
  const root = useContext(ScrollRoot);
  const reduced = useReducedMotion();
  const wide = useMediaQuery(WIDE);
  const [observable] = useState(() => typeof IntersectionObserver === 'function');
  const [state, dispatch] = useReducer(mapReducer, null, () => initialMapState({ reduced, story: observable }));
  const [fit, setFit] = useState<Fit | null>(null);
  const id = useId();
  const storyRef = useRef<HTMLDivElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const figRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLParagraphElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const mountedAt = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { mountedAt.current = performance.now(); }, []);
  useEffect(() => () => { clearTimeout(scrollTimer.current); }, []);

  // The pinned map's size, measured once before the first paint and again whenever the story, the scroll
  // container or the legend and caption change size. A frame later, never inside the observer's callback. The
  // observer starts after the commit: the scroll container is a parent, so its ref attaches only after this
  // layout effect has run, and a window that changes only its height changes the size of nothing else.
  const measure = useCallback((): void => {
    const [story, pin, fig, box, cap] = [storyRef.current, pinRef.current, figRef.current, boxRef.current, capRef.current];
    if (story === null || pin === null || fig === null || box === null || cap === null) return;
    const next = fitStory({ story, pin, fig, box, cap }, root.current, wide);
    if (next !== null) setFit((last) => (last !== null && sameFit(last, next) ? last : next));
  }, [root, wide]);
  useLayoutEffect(() => { measure(); }, [measure]);
  useEffect(() => {
    if (typeof ResizeObserver !== 'function') return undefined;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    for (const element of [storyRef.current, figRef.current, capRef.current, root.current]) if (element !== null) observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [root, measure]);

  // The intro waits for the map to come into view; a watchdog covers an observer that never reports.
  useEffect(() => {
    if (state.seen) return undefined;
    let reported = false;
    const observer = new IntersectionObserver((entries) => {
      reported = true;
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.35)) dispatch({ type: 'seen', reduced });
    }, { root: root.current, threshold: 0.4 });
    if (boxRef.current !== null) observer.observe(boxRef.current);
    const watchdog = setTimeout(() => { if (!reported) dispatch({ type: 'seen', reduced }); }, WATCHDOG_MS);
    return () => {
      clearTimeout(watchdog);
      observer.disconnect();
    };
  }, [state.seen, reduced, root]);

  // Reduced motion has no draw-in: initialMapState and 'seen' finish it at once.
  const intro = state.seen && !reduced && state.draw !== 'done';
  useEffect(() => {
    if (!intro) return undefined;
    let towns: ReturnType<typeof setTimeout> | undefined;
    const draw = setTimeout(() => {
      dispatch({ type: 'draw' });
      towns = setTimeout(() => { dispatch({ type: 'towns' }); }, DRAW_MS);
    }, Math.max(60, TITLE_MS - (performance.now() - mountedAt.current)));
    return () => {
      clearTimeout(draw);
      clearTimeout(towns);
    };
  }, [intro]);

  // The story's step: the slot alone in the band, on the page's scroll container. When no slot is in the band,
  // the sides come from layout, because the observer reports a slot only when it enters or leaves the band and a
  // jump past the story leaves the slots it skipped with their old sides. The story itself is watched too, so a
  // jump that moves no slot across the band (on phones, from past the story back to the title) still reports.
  // Native scroll only: no scroll, wheel or key listener, no snapping. A silent observer lays the map flat after a
  // second; a late report brings it back.
  const band = fit?.band ?? CENTER_BAND;
  const { top: bandTop, bottom: bandBottom, unit: bandUnit } = band;
  useEffect(() => {
    const story = storyRef.current;
    if (!observable || story === null) return undefined;
    const shape: Band = { top: bandTop, bottom: bandBottom, unit: bandUnit };
    const slots = [...story.querySelectorAll<HTMLElement>('.st-s')].sort((a, b) => Number(a.dataset.ss) - Number(b.dataset.ss));
    const sides: Side[] = slots.map(() => 'unknown');
    let reported = false;
    const observer = new IntersectionObserver((entries) => {
      reported = true;
      for (const entry of entries) {
        const index = slots.indexOf(entry.target as HTMLElement);
        if (index >= 0) sides[index] = sideOf(entry);
      }
      if (!sides.includes('in')) {
        const bounds = entries.find((entry) => entry.rootBounds !== null && entry.rootBounds.height > 0)?.rootBounds;
        const scroller = root.current;
        const edges = bounds !== undefined && bounds !== null ? { top: bounds.top, bottom: bounds.bottom }
          : bandEdges(shape, scroller === null ? 0 : scroller.getBoundingClientRect().top, scroller === null ? window.innerHeight : scroller.clientHeight);
        slots.forEach((slot, index) => { sides[index] = sideOfRect(slot.getBoundingClientRect(), edges.top, edges.bottom); });
      }
      dispatch({ type: 'band', sides: [...sides] });
    }, { root: root.current, threshold: 0, rootMargin: rootMargin(shape) });
    for (const slot of slots) observer.observe(slot);
    observer.observe(story);
    const watchdog = setTimeout(() => { if (!reported) dispatch({ type: 'story', on: false }); }, WATCHDOG_MS);
    return () => {
      clearTimeout(watchdog);
      observer.disconnect();
    };
  }, [observable, root, bandTop, bandBottom, bandUnit]);

  const month = shownMonth(state);
  const local = state.phase === 'local';
  const selected: MapTown | null = mapTowns.find((town) => town.id === state.sel) ?? null;
  const camera = selected === null ? REGION : cameraFor(selected.shape.bbox);
  const months = state.story && state.ss >= 3 && state.ss < FINAL_STEP;
  // Both frames carry the state, so the list's values hide with the map's towns.
  const appState = classes(
    local ? 'is-local' : 'is-region', selected !== null && 'is-zoomed', state.draw === 'pre' && 'is-pre',
    state.draw === 'run' && 'is-run', state.back && 'is-back', state.story && state.mby === 'scroll' && 'is-sm', state.kb && 'is-kb',
  );
  const storyClass = classes('story', state.story ? 'is-on' : 'is-flat', `ss-${String(state.ss)}`, months && 'is-months');
  const valueFade = flip('fa', state.monthTick);
  const tick = flip('tl', state.monthTick);
  const mon = `${monthLabel(month)} ${String(DATA_YEAR)}`;
  // From January on, the month's movers: value tags on the three biggest, and the job flows (particles, or with
  // reduced motion a + or −). Particles run only when the scroll moved the month, and replay on every step.
  const moving = state.story && state.ss >= 3 && month > 0;
  const flows = moving && !reduced && state.mby === 'scroll';
  const glyphs = moving && reduced;
  const burst = state.ssTick % 2 === 1 ? 'fl-a' : 'fl-b';
  const mapWidth = fit === null ? 0 : state.story || wide ? fit.mw : Math.min(1040, fit.width);
  const avoid = fit !== null && !state.story && wide ? [titleBox(fit.windowWidth, fit.width, fit.mw)] : [];
  const tags = month > 0 && (moving || !state.story) ? placeTags(month, mapWidth, avoid) : null;

  // A list selection keeps focus on its button; a marker click moves focus there. Under 900px the card
  // sits under the list, so it is brought into view, without animating for the keyboard.
  function select(townId: string, event: React.MouseEvent, fromMarker: boolean): void {
    const kb = event.detail === 0;
    dispatch({ type: 'select', id: townId, kb });
    if (fromMarker) rows.current.get(townId)?.focus({ preventScroll: true });
    if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 899px)').matches) {
      clearTimeout(scrollTimer.current);
      scrollTimer.current = setTimeout(() => {
        cardRef.current?.scrollIntoView({ block: 'nearest', behavior: reduced || kb ? 'auto' : 'smooth' });
      }, 30);
    }
  }

  // A pointer click on a marker goes to the dot nearest the click (close towns' hit areas overlap); a keyboard
  // click, or one without a position, keeps the button's own town.
  function tapped(townId: string, event: React.MouseEvent): string {
    const box = boxRef.current?.getBoundingClientRect();
    if (event.detail === 0 || box === undefined || box.width <= 0 || box.height <= 0) return townId;
    const x = ((event.clientX - box.left) / box.width) * VIEW_WIDTH;
    const y = ((event.clientY - box.top) / box.height) * VIEW_HEIGHT;
    return nearestTown(x, y) ?? townId;
  }

  // Back and Escape return focus to the town's list button; the map's own Back does it without scrolling.
  function reset(kb: boolean, fromMap: boolean): void {
    const last = state.sel;
    dispatch({ type: 'reset', kb });
    if (last !== null) rows.current.get(last)?.focus(fromMap ? { preventScroll: true } : undefined);
  }

  // Escape anywhere in the map resets a zoomed town, then dismisses a name tag (after the reset's focus
  // has set the hover to the town's button). A listener here, not on the document.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return;
    if (state.sel !== null) {
      event.preventDefault();
      reset(true, false);
    }
    if (state.hover !== null || state.sel !== null) dispatch({ type: 'hover', id: null, pointer: false });
  }

  function hover(townId: string | null, pointer: boolean): void {
    dispatch({ type: 'hover', id: townId, pointer });
  }

  const tag = selected === null ? null : cameraPoint(camera, [(selected.shape.bbox[0] + selected.shape.bbox[2]) / 2, selected.shape.bbox[3]]);

  return (
    <div className="twmap" onKeyDown={onKeyDown}>
      <style href="townwise-map" precedence="default">{mapCss}</style>
      <style href="townwise-story" precedence="default">{storyCss}</style>
      <div className={`app app-a ${appState}`}>
        <div ref={storyRef} className={storyClass}>
          <div className="st-s st-h" data-ss="0">{props.head}</div>
          <div ref={pinRef} className="story-pin">
            <div ref={figRef} className="map-fig">
              <p id={`${id}caption`} className="sr-only">Map of the nine Northeast states with twelve featured towns, each dot sized by its county’s gap from the Northeast in the month shown. Use the town list below the map to explore each one.</p>
              <div ref={boxRef} className="map-box">
                <svg className="map-svg" viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`} role="img" aria-labelledby={`${id}caption`}>
                  <g className="world" style={{ transform: cameraTransform(camera) }}>
                    <path className="m-states" d={STATES_D} />
                    {state.draw !== 'done' && (
                      <path className="m-draw" d={STATES_D} style={{ strokeDasharray: `${String(DASH.longest)} ${String(DASH.total)}`, strokeDashoffset: state.draw === 'run' ? 0 : DASH.longest }} />
                    )}
                    <path className="m-feat" d={FEATURED_D} />
                    {selected !== null && <path className="m-selc" d={selected.countyD} />}
                    {selected !== null && <path className="m-selt" d={selected.shape.d} />}
                  </g>
                  <path className="m-lead" d={LEAD_D} />
                </svg>
                <div className="ov">
                  {stateShapes.map((shape) => <span key={shape.abbr} className="st" aria-hidden="true" style={place(shape.label)}>{shape.abbr}</span>)}
                  {mapTowns.map((town, index) => {
                    const k = markerScale(valueAt(town.series.gap, month));
                    const delta = moveAt(town.series.gap, month);
                    const flow = flows ? flowOf(index, delta) : null;
                    const glyph = glyphs ? glyphOf(delta) : null;
                    const value = tags?.get(town.id);
                    const side = town.shape.labelSide;
                    const hovered = state.hover === town.id;
                    const style = {
                      ...place(town.shape.centroid), '--i': WEST.indexOf(town.id), '--k': round(k, 3), '--r': `${String(round(12 * k, 2))}px`,
                    } as React.CSSProperties;
                    return (
                      <div
                        key={town.id}
                        className={classes('mk-pos', `pat-${town.pattern}`, `side-${side}`, side === 'right' && town.shape.centroid[0] > 700 && 'edge-r', hovered && 'is-hov', hovered && state.pointer && 'is-ptr')}
                        style={style}
                        onMouseEnter={() => { hover(town.id, true); }}
                        onMouseLeave={() => { hover(null, false); }}
                      >
                        <button type="button" className="mk" tabIndex={-1} aria-hidden="true" onClick={(event) => { select(tapped(town.id, event), event, true); }}>
                          <span className="dot" />
                        </button>
                        <span className="mtag" aria-hidden="true">{town.label}</span>
                        {value !== undefined && <span className={`vtag vs-${value.side}`} aria-hidden="true">{value.text}</span>}
                        {glyph !== null && <span className={glyph === '+' ? 'mk-g g-up' : 'mk-g g-dn'} aria-hidden="true">{glyph}</span>}
                        {flow !== null && (
                          <span className={`fl fl-${flow.dir} ${burst}`} aria-hidden="true">
                            {flow.points.map((point) => <span key={point.j} className="pt" style={{ '--a': `${String(point.a)}deg`, '--d': `${String(point.d)}px`, '--j': point.j } as React.CSSProperties} />)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {selected !== null && tag !== null && (
                    <span className={state.cardTick % 2 === 1 ? 'ztag zf-a' : 'ztag zf-b'} aria-hidden="true" style={place(tag)}>{selected.label}</span>
                  )}
                  <div className="zbar">
                    <button type="button" className="zb" onClick={(event) => { reset(event.detail === 0, true); }}>Back to the Northeast</button>
                    <a className="zb" href={`#${id}town-panel`}>
                      Details below
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                        <path d="M6 1.5 V10 M2.5 6.5 L6 10 L9.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    </a>
                  </div>
                </div>
              </div>
              <Legend className="lg lg-under" />
              <div className="pin-tl" aria-hidden="true">
                <span className={classes('ptl-m', tick)}>{mon}</span>
                <ol className="ptl-r">{MONTHS.map((label, index) => <li key={label} className={railClass(index, month)}>{label}</li>)}</ol>
              </div>
            </div>
            <p ref={capRef} className="eyebrow pin-cap">Restaurant and bar jobs by county, {DATA_YEAR}. Public data (BLS QCEW). Not a forecast.</p>
          </div>
          <div className="st-tl" aria-hidden="true">
            <div className="tl-g">
              <div className="tl-rail">
                <span className="tl-fill" style={{ transform: `scaleY(${railFill(month).toFixed(4)})` }} />
                <ol>{MONTHS.map((label, index) => <li key={label} className={railClass(index, month)}>{label}</li>)}</ol>
              </div>
              <div className="tl-b">
                <p className="tl-now"><span className={classes('tl-m', tick)}>{monthLabel(month)}</span><span className="tl-y">{DATA_YEAR}</span></p>
                <div className="tl-sp">
                  <p className="tl-k">Northeast, index</p>
                  <svg viewBox="0 0 120 40" preserveAspectRatio="none" focusable="false">
                    <path className="tl-ne" d={NE_SPARK_D} vectorEffect="non-scaling-stroke" />
                    <line className="tl-cur" x1="0" y1="0" x2="0" y2="40" vectorEffect="non-scaling-stroke" style={{ transform: `translateX(${String(cursorX(month))}px)` }} />
                  </svg>
                </div>
                <p className={classes('tl-line', tick)}>{moveSentence(month)}</p>
              </div>
            </div>
          </div>
          <div className="story-steps">
            <div className="st-s st-t" data-ss="1" style={row(2)}>
              <div className="st-c">
                <p className="eyebrow">What the map shows</p>
                <h2 className="h3">The Northeast, as one pattern.</h2>
                <p>Restaurant and bar jobs in each town’s county, month by month in {DATA_YEAR}, compared with the Northeast. Public data from the U.S. Bureau of Labor Statistics (QCEW), not a Townwise forecast.</p>
                <p>Across the Northeast, restaurant and bar jobs rise and fall on one regional rhythm.</p>
              </div>
            </div>
            <div className="st-s st-t" data-ss="2" style={row(3)}>
              <div className="st-c">
                <h2 className="h3">Now the towns.</h2>
                <p>In the counties around some of these towns, they keep their own. Filled dots: counties where restaurant and bar jobs break from the region’s monthly pattern. Outlined: counties that move with it. The bigger the dot, the bigger that month’s gap.</p>
                <p className="st-ph">
                  <span className="lg-fl-m">Month by month, small dots pull in toward a town when its county’s restaurant and bar jobs rose against the Northeast since the month before, and push out when they fell.</span>
                  <span className="lg-fl-r">Month by month, a + or − beside a dot shows its county’s restaurant and bar jobs up or down against the Northeast since the month before.</span>
                </p>
              </div>
            </div>
            {MONTH_NAMES.map((name, index) => (
              <div key={name} className="st-s st-m" data-ss={index + 3} style={row(index + 4)}>
                <p className="sr-only">{name} {DATA_YEAR}. {moveSentence(index)}</p>
              </div>
            ))}
            <div className="st-s st-t st-f" data-ss={FINAL_STEP} style={row(FINAL_STEP + 1)}>
              <div className="st-c">
                <h2 className="h3">{FINALE.title}</h2>
                <p>{FINALE.line}</p>
                <p>A regional forecast averages your town away.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
      {props.lead}
      <div className={`app ${appState}`}>
        <div className="app-b">
          <div className="pane-list">
            <div className="list-h">
              <h2 className="list-pick">Pick a town to compare it with the Northeast</h2>
              <p id={`${id}list-h`} className="eyebrow list-m">Gap in {mon}</p>
            </div>
            {GROUPS.map(({ group, title }) => (
              <div key={group} className="grp">
                <div className="grp-h">
                  <p className="eyebrow">{title}</p>
                  <p className="grp-s">Same scale within this group: {GROUP_DOMAIN[group].join(' to ')}</p>
                </div>
                <ul className="rows">
                  {mapTowns.filter((town) => town.series.group === group).map((town) => {
                    const pressed = state.sel === town.id;
                    return (
                      <li key={town.id}>
                        <button
                          ref={(element) => {
                            if (element !== null) rows.current.set(town.id, element);
                            return () => { rows.current.delete(town.id); };
                          }}
                          type="button"
                          className={classes('row', pressed && 'is-sel', state.hover === town.id && 'is-hov')}
                          aria-pressed={pressed}
                          aria-controls={`${id}town-panel ${id}town-notes`}
                          aria-describedby={local ? `${id}list-h` : undefined}
                          onClick={(event) => { select(town.id, event, false); }}
                          onMouseEnter={() => { hover(town.id, true); }}
                          onMouseLeave={() => { hover(null, false); }}
                          onFocus={() => { hover(town.id, false); }}
                          onBlur={() => { hover(null, false); }}
                        >
                          <span className="row-n"><span className="row-sq" aria-hidden="true" /><span className="row-name">{town.label}</span></span>
                          <span className="row-d" aria-hidden={local ? undefined : true}>
                            <svg className="sp" viewBox="0 0 64 20" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                              <path className="sp-ne" d={spark(northeastSeries.index, GROUP_DOMAIN[group])} />
                              <path className="sp-tw" d={spark(town.series.index, GROUP_DOMAIN[group])} />
                            </svg>
                            <span className={classes('row-v', valueFade)}>{`${monthLabel(month)} ${fmtSigned(valueAt(town.series.gap, month)).padStart(VALUE_WIDTH)}`}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
          <TownPanel
            id={id}
            town={selected}
            month={month}
            valueFade={valueFade}
            cardFade={flip('cf', state.cardTick)}
            cardRef={cardRef}
            onMonth={(next, kb) => { dispatch({ type: 'month', month: next, kb }); }}
            onBack={(kb) => { reset(kb, false); }}
          />
        </div>
      </div>
      <p className="sr-only" aria-live="polite">{selected === null ? '' : `${selected.label}: ${PATTERN_LABEL[selected.pattern]}${patternGap(selected)}`}</p>
    </div>
  );
}
