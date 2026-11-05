// The map story's CSS (ConsoleV2.dc.html), a sheet of its own beside the map's (townwise-story). Every rule sits
// under .twmap: screens stay mounted in the stack. No viewport units: the pinned map's size and top come from the
// scroll container in px (--story-mw, --story-mh, --story-top, and --story-ex for the legend and caption under it).

// The skeleton. Frame A has no box: the map sits on the page ground. Steps are invisible slots; the one alone
// in the band sets the map. Flat (no observer): one map at the rest month, the step texts in a row under it; from
// 1024px the title and its actions, then the month panel 40px under them, beside the map.
const skeleton = `
.twmap .app.app-a{border:0;border-radius:0;background:transparent;overflow:visible}
.twmap .app-a .map-box{background:transparent}
.twmap .story{position:relative;display:grid;grid-template-columns:minmax(0,1fr)}
.twmap .st-h{position:relative;z-index:3;min-width:0}
.twmap .story-pin{position:relative;z-index:2;min-width:0}
.twmap .story-pin .map-fig{margin-inline:auto}
.twmap .pin-cap{padding-top:12px;transition:opacity 200ms var(--eo)}
.twmap .story-steps{position:relative;z-index:1;min-width:0}
.twmap .st-m{display:none}
.twmap .st-c{display:grid;gap:12px;align-content:start;max-width:520px}
.twmap .st-c p{color:var(--text2);text-wrap:pretty}
.twmap .story.is-flat .story-steps{display:grid;gap:24px;padding-top:32px}
.twmap .st-tl,.twmap .pin-tl{display:none}
@media (min-width:1024px){.twmap .story.is-flat{grid-template-columns:minmax(0,1fr) var(--story-mw,60%)}.twmap .story.is-flat .st-h{grid-column:1;grid-row:1;align-self:start}.twmap .story.is-flat .st-tl{display:block;grid-column:1;grid-row:2;align-self:end;padding-top:40px}.twmap .story.is-flat .tl-rail ol{line-height:40px}.twmap .story.is-flat .story-pin{grid-column:2;grid-row:1 / 3}.twmap .story.is-flat .story-steps{grid-column:1 / -1;grid-row:3;grid-template-columns:repeat(3,minmax(0,1fr));column-gap:40px}}
.twmap .story.is-on .st-m{display:block;min-height:200px}
.twmap .story.is-on .st-t{display:grid;align-content:center;min-height:560px}
.twmap .story.is-on.ss-0 .pin-cap{opacity:0}
`;

// From 1024px: the text column on the left, the map pinned on the right, centered in the scroll container. The
// month panel shares the map's sticky box (rows 1 to 16, the same top and height) and centers itself in it, so it
// stays still, centered, from January to the last step and leaves with the map only after the last step. It fades
// in at January and out at the final card, whose text runs through the same column. A zoomed town fills the map, so
// the title steps aside; focus inside it (a Tab from the header) brings back only the part with focus, the actions,
// so its links never take an invisible focus and the H1 never covers the map's Back. Hidden parts stay focusable
// and in the reading order (opacity, not visibility), and come back only once the title's 150ms fade has ended.
const wide = `
@media (min-width:1024px){
.twmap .story{padding-top:24px}
.twmap .story.is-on{grid-template-columns:minmax(0,1fr) var(--story-mw,60%)}
.twmap .story.is-on .st-h{grid-column:1;grid-row:1;min-height:calc(var(--story-mh,600px) + var(--story-ex,150px))}
.twmap .story.is-on .story-pin{grid-column:2;grid-row:1 / span 16;position:sticky;top:var(--story-top,16px);align-self:start;min-height:calc(var(--story-mh,600px) + var(--story-ex,150px))}
.twmap .story.is-on .story-steps{display:contents}
.twmap .story.is-on .st-s:not(.st-h){grid-column:1;grid-row:var(--row);padding-right:40px}
.twmap .story.is-on .st-tl{display:grid;align-content:center;grid-column:1;grid-row:1 / span 16;align-self:start;position:sticky;top:var(--story-top,16px);height:calc(var(--story-mh,600px) + var(--story-ex,150px));pointer-events:none;opacity:0;transition:opacity 200ms var(--eo)}
.twmap .story.is-on.is-months .st-tl{opacity:1}
.twmap .story.is-on .st-f{min-height:720px}
.twmap .app.is-zoomed .st-h .hd{opacity:0;pointer-events:none}
.twmap .app.is-zoomed .st-h .hd>*{transition:opacity 0s 150ms}
.twmap .app.is-zoomed .st-h .hd:focus-within{opacity:1}
.twmap .app.is-zoomed .st-h .hd:focus-within>:not(:focus-within){opacity:0;transition:none}
.twmap .app.is-zoomed .st-h .hd>:focus-within{pointer-events:auto}
}
`;

// Under 1024px: the title, then the map pinned over the top of the window on the ground color, with the month
// strip under it; the step cards scroll up from below and pass under it, so no text sits over a dot, and 16px of
// ground under the caption keeps a passing card's cut-off line clear of it. The legend
// under the map is hidden (step 2 explains the dots). The final card sits at the end of a shorter slot, so the map
// releases as soon as the card has passed under it; its top is about as far down its slot as steps 1 and 2 are
// down theirs, so it reaches the band as they do.
const narrow = `
@media (max-width:1023px){
.twmap .story.is-on{display:block}
.twmap .story.is-on .story-pin{position:sticky;top:0;padding-block:8px 16px;background:var(--ground)}
.twmap .story.is-on .story-pin .map-fig{max-width:var(--story-mw,100%)}
.twmap .story.is-on .lg-under{display:none}
.twmap .story.is-on .st-t{min-height:520px}
.twmap .story.is-on .st-f{align-content:end;min-height:280px}
.twmap .story.is-on .st-m{min-height:160px}
.twmap .story.is-on .st-c{background:var(--ground);padding-block:16px}
.twmap .story.is-on .pin-tl{display:flex;align-items:center;gap:12px;padding-top:8px}
.twmap .ptl-m{display:inline-block;flex:none;font-family:var(--mono);font-weight:500;font-size:24px;line-height:28px;text-transform:uppercase;color:var(--mint)}
.twmap .ptl-r{display:flex;flex:1;gap:3px}
.twmap .ptl-r li{flex:1;height:4px;background:var(--border);font-size:0;transition:background-color 150ms ease}
.twmap .ptl-r li.is-p,.twmap .ptl-r li.is-c{background:var(--mint)}
.twmap .ptl-m.tl-a{animation:twTickA 200ms var(--eo)}.twmap .ptl-m.tl-b{animation:twTickB 200ms var(--eo)}
.twmap .story.is-on:not(.is-months) .pin-tl{visibility:hidden}
}
`;

// The month panel: a January to December rail filling in mint, the month large, the Northeast's index with a
// cursor, and the month's biggest move. A month change ticks in (transform and opacity, 200ms). A month set by the
// scroll eases each dot with a slight overshoot; a month picked by hand jumps.
const panel = `
.twmap .tl-g{display:grid;grid-template-columns:44px minmax(0,1fr);gap:24px;align-items:start}
.twmap .tl-rail{position:relative;padding-left:14px}
.twmap .tl-rail::before{content:"";position:absolute;left:3px;top:0;bottom:0;width:2px;background:var(--border)}
.twmap .tl-fill{position:absolute;left:3px;top:0;bottom:0;width:2px;background:var(--mint);transform-origin:top;transition:transform 250ms var(--eo)}
.twmap .tl-rail ol{display:grid;gap:0;font-family:var(--mono);font-size:12px;line-height:24px;color:var(--text3)}
.twmap .tl-rail li{transition:color 150ms ease}
.twmap .tl-rail li.is-p{color:var(--text2)}
.twmap .tl-rail li.is-c{color:var(--mint)}
.twmap .tl-b{display:grid;gap:20px;align-content:start;min-width:0}
.twmap .tl-now{display:flex;align-items:baseline;gap:12px}
.twmap .tl-m{display:inline-block;font-family:var(--mono);font-weight:500;font-size:72px;line-height:72px;letter-spacing:-.02em;text-transform:uppercase;color:var(--mint)}
.twmap .tl-y{font-family:var(--mono);font-size:16px;line-height:20px;color:var(--text2)}
.twmap .tl-sp{display:grid;gap:6px}
.twmap .tl-k{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.twmap .tl-sp svg{display:block;width:100%;max-width:240px;height:48px;overflow:visible}
.twmap .tl-ne{fill:none;stroke:var(--text2);stroke-width:1.5px}
.twmap .tl-cur{stroke:var(--mint);stroke-width:2px;transition:transform 250ms var(--eo)}
.twmap .tl-line{max-width:320px;font-size:16px;line-height:24px;color:var(--text2);text-wrap:pretty}
@keyframes twTickA{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes twTickB{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.twmap .tl-m.tl-a,.twmap .tl-line.tl-a{animation:twTickA 200ms var(--eo)}.twmap .tl-m.tl-b,.twmap .tl-line.tl-b{animation:twTickB 200ms var(--eo)}
.twmap .app.is-sm .dot{transition:transform 360ms cubic-bezier(0.34,1.25,0.64,1)}
`;

// From January on, the month's movers. Flows of jobs, not people: a dot pulls particles in when its county's
// restaurant and bar jobs rose against the Northeast since last month and pushes them out when they fell; radial
// only, up to 6 a town, one 700ms burst per step (fl-a and fl-b flip on every step, backward too, so it replays);
// transform and opacity only. Value tags sit on the month's three biggest movers. With reduced motion there are no
// particles: a + or − beside each dot that moved 4 points or more, and the legend and step 2 say so instead.
const movers = `
.twmap .fl{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}
.twmap .pt{position:absolute;left:-2px;top:-2px;width:4px;height:4px;border-radius:50%;opacity:0}
.twmap .fl-in .pt{background:var(--mint)}.twmap .fl-out .pt{background:var(--text2)}
@keyframes twFlInA{0%{opacity:0;transform:rotate(var(--a)) translateX(var(--d))}25%{opacity:1}100%{opacity:0;transform:rotate(var(--a)) translateX(6px) scale(.6)}}
@keyframes twFlInB{0%{opacity:0;transform:rotate(var(--a)) translateX(var(--d))}25%{opacity:1}100%{opacity:0;transform:rotate(var(--a)) translateX(6px) scale(.6)}}
@keyframes twFlOutA{0%{opacity:0;transform:rotate(var(--a)) translateX(8px)}25%{opacity:1}100%{opacity:0;transform:rotate(var(--a)) translateX(var(--d)) scale(.6)}}
@keyframes twFlOutB{0%{opacity:0;transform:rotate(var(--a)) translateX(8px)}25%{opacity:1}100%{opacity:0;transform:rotate(var(--a)) translateX(var(--d)) scale(.6)}}
.twmap .fl-in.fl-a .pt{animation:twFlInA 700ms var(--eo) calc(var(--j) * 30ms) both}.twmap .fl-in.fl-b .pt{animation:twFlInB 700ms var(--eo) calc(var(--j) * 30ms) both}
.twmap .fl-out.fl-a .pt{animation:twFlOutA 700ms var(--eo) calc(var(--j) * 30ms) both}.twmap .fl-out.fl-b .pt{animation:twFlOutB 700ms var(--eo) calc(var(--j) * 30ms) both}
.twmap .mk-g{display:none;position:absolute;left:calc(var(--r) + 2px);top:calc(-1 * var(--r) - 12px);font-family:var(--mono);font-weight:500;font-size:12px;line-height:12px;color:var(--white);pointer-events:none}
.twmap .vtag{position:absolute;z-index:2;white-space:nowrap;font-family:var(--mono);font-size:12px;line-height:16px;color:var(--white);background:var(--ground);border:1px solid var(--border);padding:1px 6px;pointer-events:none}
.twmap .vtag.vs-right{left:calc(var(--r) + 6px);top:0;transform:translateY(-50%)}
.twmap .vtag.vs-left{right:calc(var(--r) + 6px);top:0;transform:translateY(-50%)}
.twmap .vtag.vs-above{bottom:calc(var(--r) + 6px);left:0;transform:translateX(-50%)}
.twmap .vtag.vs-below{top:calc(var(--r) + 6px);left:0;transform:translateX(-50%)}
.twmap .app:not(.is-local) .vtag,.twmap .app.is-zoomed .vtag,.twmap .mk-pos.is-hov .vtag{opacity:0}
.twmap .lg-fl-r{display:none}
@media (min-width:1024px){.twmap .st-ph{display:none}}
.twmap .story.is-flat .st-ph{display:none}
@media (prefers-reduced-motion:reduce){.twmap .fl{display:none}.twmap .mk-g{display:block}.twmap .lg-fl-m{display:none}.twmap .lg-fl-r{display:inline}}
`;

// A change made from the keyboard does not animate. Reduced motion keeps the fades and drops the movement: the
// month still follows the scroll, in steps, with no rail fill, cursor slide, month tick or dot easing.
const motion = `
.twmap .app.is-kb .hd,.twmap .app.is-kb .tl-m,.twmap .app.is-kb .ptl-m,.twmap .app.is-kb .tl-line,.twmap .app.is-kb .tl-fill,.twmap .app.is-kb .tl-cur{transition:none !important;animation:none !important}
@media (prefers-reduced-motion:reduce){.twmap .tl-fill,.twmap .tl-cur,.twmap .app.is-sm .dot{transition:none}.twmap .tl-m.tl-a,.twmap .tl-m.tl-b,.twmap .tl-line.tl-a,.twmap .tl-line.tl-b,.twmap .ptl-m.tl-a,.twmap .ptl-m.tl-b{animation:none}}
`;

export const storyCss = skeleton + wide + narrow + panel + movers + motion;
