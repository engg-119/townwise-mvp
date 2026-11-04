import type { RefObject } from 'react';

import { fmt0, fmt1, fmtSigned, side } from '../format';
import { CAVEATS, DATA_YEAR, INDEX_DEFINITION, MONTHS, northeastSeries, SOURCES } from './countyData';
import { KIND_LABEL, MONTH_NAMES, monthLabel, PATTERN_LABEL, patternGap, valueAt, type MapTown } from './mapState';

export interface TownPanelProps {
  // The useId prefix of the map: the card is `${id}town-panel` and the notes row `${id}town-notes`.
  id: string;
  town: MapTown | null;
  month: number;
  // The crossfade classes: values on a month change, the card and notes on a town change.
  valueFade: string;
  cardFade: string;
  cardRef: RefObject<HTMLDivElement | null>;
  onMonth: (month: number, kb: boolean) => void;
  onBack: (kb: boolean) => void;
}

const NE = northeastSeries.index;
const NE_DOMAIN = [5 * Math.floor(Math.min(...NE) / 5), 5 * Math.ceil(Math.max(...NE) / 5)] as const;

// The delta chart, in chart units (viewBox width 300): lines from y 8 to 128, the gap bars about a zero
// line at 172, up to 22 units each way. Path coordinates round to 0.01 and are never printed.
const CX0 = 12;
const CX1 = 288;
const CYT = 8;
const CYB = 128;
const CZERO = 172;
const CHALF = 22;

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

function cx(month: number): number {
  return CX0 + (month * (CX1 - CX0)) / 11;
}

function linePath(values: readonly number[], y: (value: number) => number): string {
  return values.map((value, month) => `${month === 0 ? 'M' : 'L'}${r2(cx(month))} ${r2(y(value))}`).join(' ');
}

interface Chart {
  height: number;
  grid: string;
  ne: string;
  town: string;
  up: string;
  down: string;
  zero: string;
  ticks: { label: string; y: number }[];
}

function chartOf(town: MapTown | null): Chart {
  const height = town === null ? 136 : 196;
  const [lo, hi] = town === null ? NE_DOMAIN : town.series.domain;
  const y = (value: number): number => CYT + ((hi - value) / (hi - lo)) * (CYB - CYT);
  const chart: Chart = {
    height,
    grid: [hi, 100, lo].map((value) => `M0 ${r2(y(value))} H300`).join(' '),
    ne: linePath(NE, y),
    town: '', up: '', down: '', zero: '',
    ticks: [{ label: String(hi), y: y(hi) }, { label: '100', y: y(100) }, { label: String(lo), y: y(lo) }],
  };
  if (town === null) return chart;
  const gaps = town.series.gap;
  const most = Math.max(...gaps.map((gap) => Math.abs(gap)));
  const bar = (gap: number, month: number): string => {
    const h = (Math.abs(gap) / most) * CHALF;
    const [a, b] = [r2(cx(month) - 6), r2(cx(month) + 6)];
    return gap >= 0 ? `M${a} ${r2(CZERO - h)} H${b} V${CZERO} H${a} Z` : `M${a} ${CZERO} H${b} V${r2(CZERO + h)} H${a} Z`;
  };
  return {
    ...chart,
    town: linePath(town.series.index, y),
    up: gaps.flatMap((gap, month) => (gap >= 0 ? [bar(gap, month)] : [])).join(' '),
    down: gaps.flatMap((gap, month) => (gap < 0 ? [bar(gap, month)] : [])).join(' '),
    zero: `M0 ${CZERO} H300`,
    ticks: [...chart.ticks, { label: fmtSigned(most), y: CZERO - CHALF }, { label: fmtSigned(-most), y: CZERO + CHALF }],
  };
}

function busiestAndQuietest(values: readonly number[]): string {
  const busiest = MONTH_NAMES[values.indexOf(Math.max(...values))] ?? '';
  const quietest = MONTH_NAMES[values.indexOf(Math.min(...values))] ?? '';
  return `Busiest month: ${busiest}. Quietest: ${quietest}.`;
}

// A source's link text is its host for a public institution (.edu, .gov) and "Source" otherwise, so no
// business name becomes visible copy; repeats within one item are numbered.
export function sourceLinks(urls: readonly string[]): { url: string; text: string }[] {
  const texts = urls.map((url) => {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return /\.(?:edu|gov)$/.test(host) ? host : 'Source';
  });
  return urls.map((url, index) => {
    const text = texts[index] ?? 'Source';
    if (texts.filter((other) => other === text).length < 2) return { url, text };
    return { url, text: `${text} ${texts.slice(0, index + 1).filter((other) => other === text).length}` };
  });
}

function Links(props: { urls: readonly string[] }): React.JSX.Element {
  return (
    <span className="lk">
      {sourceLinks(props.urls).map((link, index) => <a key={index} href={link.url} rel="noopener">{link.text}</a>)}
    </span>
  );
}

// Left and Up go back a month, Right and Down forward, wrapping; Home and End jump to January and December.
function scrubTarget(key: string, month: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return (month + 11) % 12;
    case 'ArrowRight':
    case 'ArrowDown':
      return (month + 1) % 12;
    case 'Home':
      return 0;
    case 'End':
      return 11;
    default:
      return null;
  }
}

function fmtDate(iso: string): string {
  const [year = '', month = '', day = ''] = iso.split('-');
  return `${monthLabel(Number(month) - 1)} ${Number(day)}, ${year}`;
}

export function fmtRange(start: string, end: string | null): string {
  if (end === null) return fmtDate(start);
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${fmtDate(start)} to ${fmtDate(end)}`;
  const [, month = '', day = ''] = start.split('-');
  return `${monthLabel(Number(month) - 1)} ${Number(day)} to ${fmtDate(end)}`;
}

// The card (ConsoleV2's #town-panel) and the notes row (#town-notes): the region or the chosen town's 2024
// curve against the Northeast, its gap for the month, the sentences and numbers behind it, then the drivers,
// dates, caveats and sources.
export function TownPanel(props: TownPanelProps): React.JSX.Element {
  const { id, town, month, valueFade, cardFade, cardRef, onMonth, onBack } = props;
  const chart = chartOf(town);
  const mon = `${monthLabel(month)} ${DATA_YEAR}`;
  const ne = valueAt(NE, month);
  const gap = town === null ? 0 : valueAt(town.series.gap, month);
  const datesFromCalendars = town !== null && town.kind === 'college' && town.dates.length > 0;

  function onScrubKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    const next = scrubTarget(event.key, month);
    if (next === null) return;
    event.preventDefault();
    onMonth(next, true);
    event.currentTarget.querySelectorAll('button')[next]?.focus();
  }

  return (
    <>
      <div id={`${id}town-panel`} ref={cardRef} className="pane-card" tabIndex={-1}>
        <div className={['cb', cardFade].join(' ').trim()}>
          <div className="cb-h">
            <p className="eyebrow">Historical public data, {DATA_YEAR}</p>
            {town === null ? (
              <div className="stk">
                <h2 className="ct">Northeast, {DATA_YEAR}</h2>
                <p className="cp">Across the Northeast, restaurant and bar jobs rise and fall on one regional rhythm. In the counties around some of these towns, they keep their own.</p>
              </div>
            ) : (
              <div className="stk">
                <div className="ct-row"><h2 className="ct">{town.label}</h2><span className="tag">{KIND_LABEL[town.kind]}</span></div>
                <p className="cp">{town.note}</p>
                <p className="cp">Measured across {town.county}, {DATA_YEAR}.</p>
                <p className="pat">
                  <span className={`sw sw-${town.pattern}`} aria-hidden="true" />
                  <span><span className="pat-l">{PATTERN_LABEL[town.pattern]}</span>{patternGap(town)}</span>
                </p>
              </div>
            )}
          </div>
          <div className="cb-a">
            <div className="stk">
              <div className="bv">
                {town === null ? (
                  <>
                    <p className={['bv-v is-ne', valueFade].join(' ').trim()}>{fmt1(ne)}</p>
                    <p className="bv-l">Northeast, {mon}</p>
                    <p className="bv-s">Index: 100 = an average month</p>
                  </>
                ) : (
                  <>
                    <p className={['bv-v', valueFade].join(' ').trim()}>{fmtSigned(gap)}</p>
                    <p className="bv-l">{side(gap)} the Northeast, index points, {mon}</p>
                    <p className="bv-s">{town.county} {fmt1(valueAt(town.series.index, month))} · Northeast {fmt1(ne)}</p>
                  </>
                )}
              </div>
              <div className="ch-key" aria-hidden="true">
                <span className="ck"><span className={town === null ? 'ln-tw is-empty' : 'ln-tw'} />{town === null ? 'Town’s county' : town.county}</span>
                <span className="ck"><span className="ln-ne" />Northeast</span>
              </div>
              <div>
                <div className="ch" style={{ height: chart.height }}>
                  <svg className="ch-svg" viewBox={`0 0 300 ${chart.height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
                    <path className="ch-grid" d={chart.grid} />
                    <path className="ch-zero" d={chart.zero} />
                    <path className="ch-up" d={chart.up} />
                    <path className="ch-down" d={chart.down} />
                    <path className="ch-ne" d={chart.ne} />
                    <path className="ch-town" d={chart.town} />
                    <line className="ch-cur" x1="0" y1="0" x2="0" y2={chart.height} style={{ transform: `translateX(${r2(cx(month))}px)` }} />
                  </svg>
                  {chart.ticks.map((tick, index) => (
                    <span key={index} className="tk" aria-hidden="true" style={{ top: `${r2((tick.y / chart.height) * 100)}%` }}>{tick.label}</span>
                  ))}
                </div>
                <div className="ch-x" aria-hidden="true"><span>{monthLabel(0)}</span><span>{DATA_YEAR}</span><span>{monthLabel(11)}</span></div>
              </div>
              <p className="ch-cap">{town === null ? '' : 'Scale fitted to this town. '}Index: 100 = an average month</p>
              <div className="scrub" role="radiogroup" aria-label="Month" onKeyDown={onScrubKey}>
                {MONTHS.map((label, index) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    className="sb"
                    aria-checked={index === month}
                    tabIndex={index === month ? 0 : -1}
                    onClick={(event) => { onMonth(index, event.detail === 0); }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="cb-t">
            <div className="tx">
              {town === null ? <p>{busiestAndQuietest(NE)}</p> : <TownSentences town={town} />}
            </div>
            <details className="nums">
              <summary><span>Show the numbers</span></summary>
              <div className="tbl" role="region" tabIndex={0} aria-label={`Numbers: ${town === null ? 'the Northeast' : `${town.county} and the Northeast`}, ${DATA_YEAR}`}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Month</th>
                      {town === null ? <th scope="col">Northeast</th> : <><th scope="col">{town.county}</th><th scope="col">Northeast</th><th scope="col">Gap</th></>}
                    </tr>
                  </thead>
                  <tbody>
                    {MONTHS.map((label, index) => (
                      <tr key={label}>
                        <th scope="row">{label}</th>
                        {town !== null && <td>{fmt1(valueAt(town.series.index, index))}</td>}
                        <td>{fmt1(valueAt(NE, index))}</td>
                        {town !== null && <td>{fmtSigned(valueAt(town.series.gap, index))}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
          {town !== null && (
            <div className="cb-x">
              <button type="button" className="back" onClick={(event) => { onBack(event.detail === 0); }}>Back to the Northeast</button>
            </div>
          )}
        </div>
      </div>
      <div id={`${id}town-notes`} className="pane-notes">
        <div className={['nt', cardFade].join(' ').trim()}>
          {town !== null && town.drivers.length > 0 && (
            <div className="why">
              <p className="eyebrow">Drivers</p>
              <ul>{town.drivers.map((driver, index) => <li key={index}><span>{driver.text}</span><Links urls={driver.sourceUrls} /></li>)}</ul>
            </div>
          )}
          {town !== null && town.dates.length > 0 && (
            <div className="why">
              <p className="eyebrow">Dates</p>
              <ul>{town.dates.map((date, index) => <li key={index}><span>{date.text}, {fmtRange(date.start, date.end)}</span><Links urls={date.sourceUrls} /></li>)}</ul>
            </div>
          )}
          <div className="nt-c">
            <ul className="cav">{CAVEATS.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
            {town !== null && town.drivers.length + town.dates.length > 0 && (
              <p className="fine">Chart: {DATA_YEAR} restaurant and bar jobs.{datesFromCalendars ? ' Dates: published calendars.' : ''}</p>
            )}
            {town !== null && (
              <>
                <p className="fine">Source: U.S. Bureau of Labor Statistics, QCEW, private food services and drinking places (NAICS 722), {town.county}, {DATA_YEAR}.</p>
                <p className="fine">County level. Jobs stand in for demand; they are not sales.</p>
              </>
            )}
            <p className="fine">{INDEX_DEFINITION}</p>
          </div>
          <div className="nt-c">
            <ul className="srcs mono-s">{SOURCES.map((source) => <li key={source.url}><a href={source.url} rel="noopener">{source.label}</a></li>)}</ul>
          </div>
        </div>
      </div>
    </>
  );
}

// The copy file's sentences for a town, read off its county's index and largest gap.
function TownSentences(props: { town: MapTown }): React.JSX.Element {
  const { county, pattern, kind, series } = props.town;
  const { index, largestGap } = series;
  const gapMonth = MONTH_NAMES[largestGap.monthIndex] ?? '';
  const swing = fmt0((Math.max(...index) / Math.min(...index) - 1) * 100);
  return (
    <>
      <p>{busiestAndQuietest(index)}</p>
      <p>Food-service jobs in {county} swing {swing}% from the quietest month to the busiest.</p>
      <p>Biggest gap with the region: {gapMonth}. {county} sat at {fmt0(largestGap.countyIndex)}; the Northeast sat at {fmt0(largestGap.northeastIndex)}.</p>
      {pattern !== 'moves' && <p>A forecast that follows the region’s monthly pattern would miss most in {gapMonth}.</p>}
      {pattern === 'opposite' && <p>{county} runs opposite the region: busy when the Northeast is quiet.</p>}
      {pattern === 'moves' && <p>Month to month, {county} moves close to the region.</p>}
      {pattern === 'moves' && kind === 'college' && (
        <p>A college calendar acts week by week: finals, Commencement, homecoming. Monthly job counts cannot show a single week, which is why Townwise researches the town’s own calendar.</p>
      )}
    </>
  );
}
