import { useEffect, useId, useReducer, useRef } from 'react';

import { fmt1, fmtSigned } from '../format';
import { useReducedMotion } from '../useReducedMotion.web';
import { cameraFor, cameraPoint, cameraTransform, REGION } from './camera';
import { DATA_YEAR, GROUP_DOMAIN, MAX_ABS_GAP, northeastSeries, type TownGroup } from './countyData';
import { FEATURED_D, stateShapes, STATES_D, VIEW_HEIGHT, VIEW_WIDTH, type Point } from './geometry';
import {
  initialMapState, mapReducer, mapTowns, markerScale, monthLabel, PATTERN_LABEL, patternGap, PATTERNS, shownMonth,
  valueAt, type MapTown,
} from './mapState';
import { mapCss } from './mapStyles.web';
import { TownPanel } from './TownPanel.web';

// The intro: the outlines start drawing once the hero title has mostly landed (450ms from mount, or a frame
// after the map comes into view), draw for 900ms, then the towns appear and the year plays.
const TITLE_MS = 450;
const DRAW_MS = 900;
const WATCHDOG_MS = 1000;

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
    </div>
  );
}

// The homepage map (ConsoleV2.dc.html): the nine Northeast states and twelve towns, the Region / Towns toggle,
// the town list (the keyboard and screen-reader control; markers are aria-hidden and out of the tab order),
// and the panel for the chosen town.
export function NortheastMap(): React.JSX.Element {
  const reduced = useReducedMotion();
  const [state, dispatch] = useReducer(mapReducer, reduced, (startReduced) =>
    initialMapState({ reduced: startReduced, seen: typeof IntersectionObserver !== 'function' }));
  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const mountedAt = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { mountedAt.current = performance.now(); }, []);
  useEffect(() => () => { clearTimeout(scrollTimer.current); }, []);

  // The intro waits for the map to come into view. Without an observer it counts as in view at once
  // (initialMapState); a watchdog covers an observer that never reports.
  useEffect(() => {
    if (state.seen) return undefined;
    let reported = false;
    const observer = new IntersectionObserver((entries) => {
      reported = true;
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.35)) dispatch({ type: 'seen', reduced });
    }, { threshold: 0.4 });
    if (boxRef.current !== null) observer.observe(boxRef.current);
    const watchdog = setTimeout(() => { if (!reported) dispatch({ type: 'seen', reduced }); }, WATCHDOG_MS);
    return () => {
      clearTimeout(watchdog);
      observer.disconnect();
    };
  }, [state.seen, reduced]);

  // Reduced motion has no intro: initialMapState and 'seen' show the towns at the rest month at once.
  useEffect(() => {
    if (!state.seen || reduced) return undefined;
    let towns: ReturnType<typeof setTimeout> | undefined;
    const draw = setTimeout(() => {
      dispatch({ type: 'draw' });
      towns = setTimeout(() => { dispatch({ type: 'towns' }); }, DRAW_MS);
    }, Math.max(60, TITLE_MS - (performance.now() - mountedAt.current)));
    return () => {
      clearTimeout(draw);
      clearTimeout(towns);
    };
  }, [state.seen, reduced]);

  // The playing year, one month per timer. A pause or any use of the map stops it (WCAG 2.2.2).
  useEffect(() => {
    if (state.play !== 'on' || reduced) return undefined;
    const timer = setTimeout(() => { dispatch({ type: 'step' }); }, state.wait);
    return () => { clearTimeout(timer); };
  }, [state.play, state.step, state.wait, reduced]);

  const month = shownMonth(state);
  const local = state.phase === 'local';
  const selected: MapTown | null = mapTowns.find((town) => town.id === state.sel) ?? null;
  const camera = selected === null ? REGION : cameraFor(selected.shape.bbox);
  const playing = state.play === 'on';
  const appClass = classes(
    'app', local ? 'is-local' : 'is-region', selected !== null && 'is-zoomed',
    state.draw === 'pre' && 'is-pre', state.draw === 'run' && 'is-run', state.back && 'is-back',
    (playing || state.play === 'end') && 'is-play', state.kb && 'is-kb',
  );
  const valueFade = flip('fa', state.monthTick);
  const mon = `${monthLabel(month)} ${DATA_YEAR}`;

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
      <div className={appClass}>
        <div className="pane-map">
          <div className="map-fig">
            <div ref={boxRef} className="map-box">
              <svg className="map-svg" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img" aria-labelledby={`${id}caption`}>
                <g className="world" style={{ transform: cameraTransform(camera) }}>
                  <path className="m-states" d={STATES_D} />
                  {state.draw !== 'done' && (
                    <path className="m-draw" d={STATES_D} style={{ strokeDasharray: `${DASH.longest} ${DASH.total}`, strokeDashoffset: state.draw === 'run' ? 0 : DASH.longest }} />
                  )}
                  <path className="m-feat" d={FEATURED_D} />
                  {selected !== null && <path className="m-selc" d={selected.countyD} />}
                  {selected !== null && <path className="m-selt" d={selected.shape.d} />}
                </g>
                <path className="m-lead" d={LEAD_D} />
              </svg>
              <div className="ov">
                {stateShapes.map((shape) => <span key={shape.abbr} className="st" aria-hidden="true" style={place(shape.label)}>{shape.abbr}</span>)}
                {mapTowns.map((town) => {
                  const k = markerScale(valueAt(town.series.gap, month));
                  const side = town.shape.labelSide;
                  const hovered = state.hover === town.id;
                  const style = {
                    ...place(town.shape.centroid), '--i': WEST.indexOf(town.id), '--k': round(k, 3), '--r': `${round(12 * k, 2)}px`,
                  } as React.CSSProperties;
                  return (
                    <div
                      key={town.id}
                      className={classes('mk-pos', `pat-${town.pattern}`, `side-${side}`, side === 'right' && town.shape.centroid[0] > 700 && 'edge-r', hovered && 'is-hov', hovered && state.pointer && 'is-ptr')}
                      style={style}
                      onMouseEnter={() => { hover(town.id, true); }}
                      onMouseLeave={() => { hover(null, false); }}
                    >
                      <button type="button" className="mk" tabIndex={-1} aria-hidden="true" onClick={(event) => { select(town.id, event, true); }}>
                        <span className="dot" />
                      </button>
                      <span className="mtag" aria-hidden="true">{town.label}</span>
                    </div>
                  );
                })}
                {selected !== null && tag !== null && (
                  <span className={state.cardTick % 2 === 1 ? 'ztag zf-a' : 'ztag zf-b'} aria-hidden="true" style={place(tag)}>{selected.label}</span>
                )}
                <div className="hud">
                  <div className="mon">
                    <span className={classes('mon-l', flip('tk', state.monthTick))} aria-hidden="true">{mon}</span>
                    {!reduced && (
                      <button type="button" className="mon-b" aria-label={playing ? 'Pause the year' : 'Play the year'} onClick={() => { dispatch({ type: 'togglePlay' }); }}>
                        <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                          <path d={playing ? 'M3 2H6V12H3Z M8 2H11V12H8Z' : 'M3.5 1.5L12.5 7L3.5 12.5Z'} />
                        </svg>
                        <span>{playing ? 'Pause' : 'Play'}</span>
                      </button>
                    )}
                  </div>
                  <Legend className="lg lg-on" />
                </div>
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
          </div>
        </div>
        <div className="tb">
          <p className="eyebrow tb-l">Restaurant and bar jobs by county, {DATA_YEAR}</p>
          <div className="tg" role="group" aria-label="Region / Towns">
            <button type="button" aria-pressed={!local} onClick={(event) => { dispatch({ type: 'phase', phase: 'region', kb: event.detail === 0 }); }}>Region</button>
            <button type="button" aria-pressed={local} onClick={(event) => { dispatch({ type: 'phase', phase: 'local', kb: event.detail === 0 }); }}>Towns</button>
          </div>
          <p className="eyebrow tb-r">Public data (BLS QCEW). Not a forecast.</p>
        </div>
        <div className="map-cap">
          <p><strong>What the map shows.</strong> Restaurant and bar jobs in each town’s county, month by month in {DATA_YEAR}, compared with the Northeast. Public data from the U.S. Bureau of Labor Statistics (QCEW), not a Townwise forecast.</p>
          <p>
            {selected !== null ? <strong>{selected.label}.</strong>
              : local ? <><strong>Now the towns.</strong> Filled dots: counties where restaurant and bar jobs break from the region’s monthly pattern. Outlined: counties that move with it. The bigger the dot, the bigger that month’s gap.</>
                : <><strong>The Northeast, as one pattern.</strong> Monthly food-service employment across the nine Northeast states, {DATA_YEAR}.</>}
          </p>
          <p><span className="inst-ptr">Click a town to compare it with the region.</span><span className="inst-touch">Tap a town to compare it with the region.</span> Or choose a town from the list below the map.</p>
          <p id={`${id}caption`} className="mono-s">Map of the nine Northeast states with twelve featured towns, each dot sized by its county’s gap from the Northeast in the month shown. Use the town list below the map to explore each one.</p>
          <p className="mono-s">Dashed: county · Data: {DATA_YEAR}</p>
        </div>
      </div>

      <div className={appClass}>
        <div className="app-b">
          <div className="pane-list">
            <div className="list-h"><p id={`${id}list-h`} className="eyebrow">Gap in {mon}</p></div>
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
