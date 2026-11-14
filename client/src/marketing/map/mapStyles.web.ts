import { theme } from '../../theme';

// The homepage map's CSS, from ConsoleV2.dc.html, with colors, curves, strokes and durations from the theme.
// The page colors and --eo come from the marketing chrome (.tw). Every rule sits under .twmap: screens stay
// mounted in the stack, so this sheet applies document-wide while the homepage is mounted.

const c = theme.color;
const m = theme.motion;
const s = theme.stroke;
const easeInOut = `cubic-bezier(${m.easeInOut.join(',')})`;

// The town list, card and notes: stacked on phones; from 900px the list beside the card with the notes across the
// bottom. From 1160px the card has its two columns (its container is 680px or more) and is short beside the list's
// twelve towns, so the notes move under it, beside the list.
const frame = `
.twmap{--eio:${easeInOut}}
.twmap button{font-family:inherit}
.twmap .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.twmap .app{border:1px solid var(--border);border-radius:${theme.radius.frame}px;background:var(--panel);overflow:clip}
.twmap .map-fig{width:100%;max-width:1040px;margin-inline:auto;container-type:inline-size;container-name:map}
.twmap .app-b{display:grid;grid-template-columns:minmax(0,1fr);grid-template-areas:"list" "card" "notes"}
.twmap .pane-list{grid-area:list;min-width:0;padding:8px}
.twmap .pane-card{grid-area:card;min-width:0;padding:16px;background:var(--raised);border-top:1px solid var(--border);container-type:inline-size;container-name:card}
.twmap .pane-notes{grid-area:notes;min-width:0}
@media (min-width:900px){.twmap .app-b{grid-template-columns:300px minmax(0,1fr);grid-template-areas:"list card" "notes notes"}.twmap .pane-list{border-right:1px solid var(--border)}.twmap .pane-card{border-top:0}}
@media (min-width:1160px){.twmap .app-b{grid-template-rows:auto 1fr;grid-template-areas:"list card" "list notes"}}
.twmap .mono-s{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
`;

// The map: one SVG for land, an HTML overlay for labels and markers. The zoom moves the world group on
// screen (ease-in-out, under 300ms). Intro, once: the outlines draw in (is-pre, then is-run for 900ms) and
// the land fades in under them.
const map = `
.twmap .map-box{position:relative;aspect-ratio:1000/870;overflow:clip;background:var(--panel)}
.twmap .map-svg{position:absolute;inset:0;width:100%;height:100%;display:block}
.twmap .world{transform-box:view-box;transform-origin:0 0;transition:transform ${m.zoom}ms var(--eio)}
.twmap .map-svg path{vector-effect:non-scaling-stroke}
.twmap .m-states{fill:var(--state);stroke:var(--line);stroke-width:${s.state}px;transition:opacity ${m.zoom}ms var(--eo)}
.twmap .map-svg .m-draw{fill:none;stroke:var(--line);stroke-width:1.2px;vector-effect:none}
.twmap .app.is-run .m-draw{transition:stroke-dashoffset 900ms var(--eo)}
.twmap .app.is-pre .m-states{opacity:0}
.twmap .app.is-run .m-states{transition:opacity 400ms var(--eo) 500ms}
.twmap .app:not(.is-local) .st,.twmap .app:not(.is-local) .m-lead{opacity:0}
.twmap .m-feat{fill:none;stroke:var(--line);stroke-width:${s.hairline}px;stroke-dasharray:2 3;opacity:0;transition:opacity ${m.fade}ms var(--eo)}
.twmap .app.is-local .m-feat{opacity:1}
.twmap .app.is-zoomed .m-states,.twmap .app.is-zoomed .m-feat{opacity:.4}
.twmap .m-selc{fill:none;stroke:var(--mint);stroke-width:${s.emph}px}
.twmap .m-selt{fill:var(--mint);stroke:none}
.twmap .m-lead{fill:none;stroke:var(--text3);stroke-width:${s.hairline}px;transition:opacity ${m.fade}ms var(--eo)}
.twmap .ov{position:absolute;inset:0}
.twmap .st{position:absolute;transform:translate(-50%,-50%);font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3);pointer-events:none;transition:opacity ${m.fade}ms var(--eo)}
.twmap .app.is-zoomed .st,.twmap .app.is-zoomed .m-lead{opacity:0}
@media (max-width:640px){.twmap .app.is-local .st,.twmap .app.is-local .m-lead{opacity:0}}
.twmap .mk-pos{position:absolute;width:0;height:0;opacity:0;transform:scale(.6);pointer-events:none;transition:opacity 150ms var(--eo),transform 150ms var(--eo)}
.twmap .app.is-local .mk-pos{opacity:1;transform:none;pointer-events:auto;transition:opacity 280ms var(--eo) calc(var(--dz,0ms) + var(--i) * var(--stg,50ms)),transform 280ms var(--eo) calc(var(--dz,0ms) + var(--i) * var(--stg,50ms))}
.twmap .app.is-back{--dz:${m.zoom}ms;--stg:30ms}
.twmap .app.is-zoomed .mk-pos{opacity:0;pointer-events:none;transition:none}
.twmap .mk{position:absolute;left:-22px;top:-22px;width:44px;height:44px;margin:0;padding:0;border:0;background:transparent;cursor:pointer;display:grid;place-items:center;transition:transform 150ms ease}
.twmap .mk-pos.is-hov{z-index:3}
@media (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference){.twmap .mk-pos.is-hov.is-ptr .mk{transform:scale(1.25)}}
.twmap .dot{position:relative;display:block;width:24px;height:24px;border-radius:50%;background:var(--mint);outline:2px solid ${c.mintRing};outline-offset:3px;transform:scale(var(--k,1))}
.twmap .pat-moves .dot{background:transparent;border:3px solid var(--mint);outline:0}
.twmap .pat-opposite .dot::after{content:"";position:absolute;left:20%;right:20%;top:50%;height:4px;margin-top:-2px;background:var(--ground)}
.twmap .mtag{position:absolute;z-index:2;white-space:nowrap;font-family:var(--mono);font-size:12px;line-height:16px;color:var(--white);background:var(--raised);border:1px solid var(--border);padding:1px 6px;pointer-events:none;opacity:0;--off:6px}
.twmap .mk-pos.is-ptr .mtag{transition:opacity 120ms ease}
.twmap .side-right .mtag{left:calc(var(--r) + var(--off));top:0;transform:translateY(-50%)}
.twmap .side-left .mtag{right:calc(var(--r) + var(--off));top:0;transform:translateY(-50%)}
.twmap .side-above .mtag{bottom:calc(var(--r) + var(--off));left:0;transform:translateX(-50%)}
.twmap .side-below .mtag{top:calc(var(--r) + var(--off));left:0;transform:translateX(-50%)}
.twmap .mk-pos.is-hov .mtag{opacity:1}
.twmap .app.is-local:not(.is-zoomed) .mk-pos.is-hov .mtag{pointer-events:auto}
@media (max-width:640px){.twmap .mtag{--off:4px}}
@container map (max-width:640px){.twmap .edge-r .mtag{left:auto;right:calc(var(--r) + var(--off))}}
.twmap .ztag{position:absolute;transform:translate(-50%,10px);white-space:nowrap;font-family:var(--mono);font-weight:500;font-size:12px;line-height:16px;color:var(--white);background:var(--raised);border:1px solid var(--border);padding:4px 8px;pointer-events:none}
@keyframes twTagA{0%,66%{opacity:0}100%{opacity:1}}
@keyframes twTagB{0%,66%{opacity:0}100%{opacity:1}}
.twmap .ztag.zf-a{animation:twTagA 420ms var(--eo)}
.twmap .ztag.zf-b{animation:twTagB 420ms var(--eo)}
.twmap .lg{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3);display:grid;gap:4px;transition:opacity ${m.fade}ms var(--eo)}
.twmap .lg ul{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px}
.twmap .lg li{display:flex;align-items:center;gap:6px;min-height:16px}
.twmap .lg-under{padding-top:12px}
.twmap .app:not(.is-local) .lg-under{opacity:0;visibility:hidden}
.twmap .sw{position:relative;display:inline-block;flex:none;width:12px;height:12px;border-radius:50%;background:var(--mint)}
.twmap .sw-moves{background:transparent;border:1.5px solid var(--mint)}
.twmap .sw-breaks,.twmap .sw-opposite{outline:1px solid ${c.mintRing};outline-offset:2px}
.twmap .sw-opposite::after{content:"";position:absolute;left:20%;right:20%;top:50%;height:2px;margin-top:-1px;background:var(--ground)}
.twmap .sw.sw-sz{background:transparent;border:1.5px solid var(--line)}
.twmap .sw.s-lo{width:8px;height:8px}.twmap .sw.s-hi{width:24px;height:24px}
.twmap .zbar{position:absolute;left:12px;top:12px;z-index:4;display:flex;flex-wrap:wrap;gap:8px;max-width:calc(100% - 24px);opacity:0;visibility:hidden;transition:opacity 150ms var(--eo),visibility 150ms}
.twmap .app.is-zoomed .zbar{opacity:1;visibility:visible;transition:opacity ${m.fade}ms var(--eo) ${m.zoom}ms,visibility 0s}
.twmap .zb{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;background:var(--panel);color:var(--white);border:1px solid var(--line);border-radius:0;font-family:var(--sans);font-size:14px;line-height:20px;font-weight:500;text-decoration:none;cursor:pointer;transition:border-color ${m.select}ms ease}
@media (hover:hover){.twmap .zb:hover{color:var(--white);border-color:var(--white)}}
`;

// The town list, the card and the notes row under the panes. On phones the card's sentences are body size and
// the notes' longer mono lines 14px.
const panel = `
.twmap .list-h{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 16px;min-height:32px;padding:4px 11px}
.twmap .list-pick{font-size:14px;line-height:20px;font-weight:600;color:var(--white)}
.twmap .list-m{margin-left:auto;transition:opacity ${m.fade}ms var(--eo)}
.twmap .app:not(.is-local) .list-m{opacity:0}
.twmap .grp{border-top:1px solid var(--border);padding-top:4px}
.twmap .grp+.grp{margin-top:8px}
.twmap .grp-h{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:2px 8px;padding:6px 10px}
.twmap .grp-s{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.twmap .rows{display:grid;gap:2px}
@media (max-width:899px){.twmap .rows{grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}}
@media (max-width:379px){.twmap .rows{grid-template-columns:minmax(0,1fr)}}
.twmap .row{display:grid;gap:4px;width:100%;min-height:44px;margin:0;padding:6px 10px;text-align:left;background:transparent;color:var(--white);border:1px solid transparent;border-radius:0;cursor:pointer;transition:background-color ${m.select}ms ease,border-color ${m.select}ms ease}
@media (hover:hover){.twmap .row:hover{background:var(--raised)}}
.twmap .row.is-hov{background:var(--raised)}
.twmap .row.is-sel{background:var(--raised);border-color:var(--border)}
.twmap .row-n{display:flex;align-items:center;gap:6px;min-width:0;font-size:14px;line-height:20px;font-weight:500}
.twmap .row-sq{flex:none;width:6px;height:6px;background:transparent;transition:background-color ${m.select}ms ease}
.twmap .row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:color ${m.select}ms ease}
.twmap .row.is-sel .row-sq{background:var(--mint)}
.twmap .row.is-sel .row-name{color:var(--mint)}
.twmap .row-d{display:flex;align-items:center;gap:8px;padding-left:12px;min-height:20px;transition:opacity ${m.fade}ms var(--eo)}
.twmap .app:not(.is-local) .row-d{opacity:0}
@media (max-width:899px){.twmap .row-d{padding-left:0}}
.twmap .sp{flex:0 1 64px;min-width:40px;height:20px;overflow:visible}
.twmap .sp path{vector-effect:non-scaling-stroke}
.twmap .sp-ne{fill:none;stroke:${c.seriesNortheast};stroke-width:${s.hairline};stroke-dasharray:2 2}
.twmap .sp-tw{fill:none;stroke:var(--mint);stroke-width:${s.emph};stroke-linejoin:round}
.twmap .row-v{margin-left:auto;min-width:9ch;text-align:right;font-family:var(--mono);font-weight:500;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--text2);white-space:pre}
.twmap .cb{display:grid;gap:16px;align-content:start}
.twmap .cb-h,.twmap .cb-a,.twmap .cb-t{display:grid;gap:12px;align-content:start;min-width:0}
.twmap .cb-h .stk{gap:8px}
@container card (min-width:680px){.twmap .cb{grid-template-columns:minmax(0,1fr) minmax(0,420px);grid-template-rows:auto auto 1fr;grid-template-areas:"h a" "t a" "x a";column-gap:40px}.twmap .cb-h{grid-area:h}.twmap .cb-a{grid-area:a}.twmap .cb-t{grid-area:t}.twmap .cb-x{grid-area:x;align-self:start}}
.twmap .stk{display:grid;gap:12px;align-content:start;min-width:0}
.twmap .ct-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.twmap .ct{font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.01em}
@media (max-width:640px){.twmap .ct{font-size:20px;line-height:24px}}
.twmap .cp{font-size:14px;line-height:20px;color:var(--text2);text-wrap:pretty}
.twmap .pat{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:20px;color:var(--text2);text-wrap:pretty}
.twmap .pat .sw{margin-top:4px}
.twmap .pat-l{font-weight:500;color:var(--white)}
.twmap .bv{display:grid;gap:6px}
.twmap .bv-v{font-family:var(--mono);font-weight:500;font-size:56px;line-height:56px;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--mint)}
.twmap .bv-v.is-ne{color:var(--white)}
.twmap .bv-l{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.twmap .bv-s{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text2);font-variant-numeric:tabular-nums}
@media (max-width:640px){.twmap .bv-v{font-size:40px;line-height:40px}}
.twmap .ch-key{display:flex;flex-wrap:wrap;gap:4px 16px;font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text2)}
.twmap .ck{display:inline-flex;align-items:center;gap:6px}
.twmap .ln-tw,.twmap .ln-ne{display:inline-block;width:16px;height:0;border-top:${s.series}px solid var(--mint)}
.twmap .ln-tw.is-empty{border-top:${s.hairline}px solid var(--line)}
.twmap .ln-ne{border-top:${s.series}px dashed ${c.seriesNortheast}}
.twmap .ch{position:relative;margin:4px 0 0 44px}
.twmap .ch-svg{position:absolute;inset:0;width:100%;height:100%;display:block;overflow:visible}
.twmap .ch-svg path,.twmap .ch-svg line{vector-effect:non-scaling-stroke}
.twmap .ch-grid{fill:none;stroke:var(--border);stroke-width:${s.hairline}px}
.twmap .ch-zero{fill:none;stroke:var(--line);stroke-width:${s.hairline}px}
.twmap .ch-ne{fill:none;stroke:${c.seriesNortheast};stroke-width:${s.emph}px;stroke-dasharray:4 3}
.twmap .ch-town{fill:none;stroke:var(--mint);stroke-width:${s.series}px;stroke-linejoin:round}
.twmap .ch-up{fill:var(--mint)}
.twmap .ch-down{fill:none;stroke:var(--line);stroke-width:${s.hairline}px}
.twmap .ch-cur{stroke:var(--white);stroke-width:${s.hairline}px;transition:transform ${m.cursor}ms var(--eio)}
.twmap .tk{position:absolute;left:-44px;width:38px;text-align:right;transform:translateY(-50%);font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3);font-variant-numeric:tabular-nums}
.twmap .ch-x{display:flex;justify-content:space-between;margin:6px 0 0 44px;font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.twmap .ch-cap{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.twmap .scrub{display:grid;grid-template-columns:repeat(6,44px);gap:4px}
.twmap .sb{width:44px;min-height:44px;margin:0;padding:0;font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text2);background:var(--raised);border:1px solid var(--line);border-radius:0;cursor:pointer;transition:background-color ${m.select}ms ease,color ${m.select}ms ease}
@media (hover:hover){.twmap .sb:hover{color:var(--white)}}
.twmap .sb[aria-checked="true"]{background:var(--mint);border-color:var(--mint);color:var(--ground)}
@container card (max-width:283px){.twmap .scrub{grid-template-columns:repeat(4,44px)}}
.twmap .tx{display:grid;gap:8px;align-content:start;min-width:0;font-size:14px;line-height:20px;color:var(--text2)}
.twmap .nums summary{display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;list-style:none;font-size:14px;line-height:20px;font-weight:500;color:var(--white)}
.twmap .nums summary::-webkit-details-marker{display:none}
.twmap .nums summary::before{content:"+";flex:none;display:grid;place-items:center;width:16px;height:16px;border:1px solid var(--line);font-family:var(--mono);font-size:12px;line-height:1;font-weight:400;color:var(--text2)}
.twmap .nums[open] summary::before{content:"\\2212"}
.twmap .nums summary span{text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}
@media (hover:hover){.twmap .nums summary:hover{color:var(--mint)}}
@media (hover:hover){.twmap .nums summary:hover span{text-decoration-color:var(--mint)}}
@media (hover:hover){.twmap .nums summary:hover::before{border-color:var(--mint);color:var(--mint)}}
.twmap .tbl{margin-top:4px;overflow-x:auto}
.twmap .nums table{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;color:var(--text2)}
.twmap .nums th,.twmap .nums td{text-align:right;padding:4px 0 4px 8px;border-bottom:1px solid var(--border);font-weight:400}
.twmap .nums thead th{color:var(--text3);vertical-align:bottom}
.twmap .nums th:first-child,.twmap .nums td:first-child{text-align:left;padding-left:0}
.twmap .back{justify-self:start;min-height:44px;padding:0 14px;background:transparent;color:var(--white);border:1px solid var(--line);border-radius:0;font-size:14px;line-height:20px;font-weight:500;cursor:pointer;transition:border-color ${m.select}ms ease}
@media (hover:hover){.twmap .back:hover{border-color:var(--white)}}
.twmap .nt{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:24px;align-items:start;padding:16px;border-top:1px solid var(--border)}
.twmap .nt-c{display:grid;gap:12px;align-content:start;min-width:0}
.twmap .why{display:grid;gap:6px;align-content:start;min-width:0}
.twmap .why li{display:grid;font-size:14px;line-height:20px;color:var(--text2)}
.twmap .why li+li{margin-top:4px}
.twmap .lk{display:block}
.twmap .lk a{display:inline-flex;align-items:center;min-height:44px;margin-right:12px;font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text2)}
@media (hover:hover){.twmap .lk a:hover{color:var(--mint)}}
.twmap .cav li+li{margin-top:4px}
.twmap .cav li,.twmap .fine{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.twmap .srcs{display:grid}
.twmap .srcs a{display:inline-flex;align-items:center;min-height:44px;color:var(--text3)}
@media (hover:hover){.twmap .srcs a:hover{color:var(--mint)}}
@media (max-width:640px){.twmap .cp,.twmap .pat,.twmap .tx,.twmap .why li{font-size:16px;line-height:24px}.twmap .cav li,.twmap .fine,.twmap .srcs a{font-size:14px;line-height:20px}}
`;

// Crossfades replay because their class flips between two identical copies on each change. A change made
// from the keyboard (is-kb) does not animate. Reduced motion keeps the fades and drops the movement: the
// zoom, the marker scale, the cursor slide and the press (the script skips the draw-in).
const motion = `
@keyframes twFadeA{from{opacity:0}to{opacity:1}}
@keyframes twFadeB{from{opacity:0}to{opacity:1}}
.twmap .fa-a{animation:twFadeA ${m.select}ms var(--eo)}.twmap .fa-b{animation:twFadeB ${m.select}ms var(--eo)}
.twmap .cf-a{animation:twFadeA ${m.fade}ms var(--eo)}.twmap .cf-b{animation:twFadeB ${m.fade}ms var(--eo)}
.twmap .app.is-kb .world,.twmap .app.is-kb .ch-cur,.twmap .app.is-kb .mk-pos,.twmap .app.is-kb .zbar,.twmap .app.is-kb .ztag,.twmap .app.is-kb .row-v,.twmap .app.is-kb .bv-v,.twmap .app.is-kb .cb,.twmap .app.is-kb .nt,.twmap .app.is-kb .lg,.twmap .app.is-kb .m-states,.twmap .app.is-kb .m-feat,.twmap .app.is-kb .m-lead,.twmap .app.is-kb .st,.twmap .app.is-kb .list-m,.twmap .app.is-kb .row-d,.twmap .app.is-kb .row,.twmap .app.is-kb .row-sq,.twmap .app.is-kb .row-name,.twmap .app.is-kb .sb{transition:none !important;animation:none !important}
.twmap .row:focus-visible,.twmap .row:focus-visible *{transition:none}
@media (prefers-reduced-motion:reduce){.twmap .world,.twmap .dot,.twmap .mk,.twmap .ch-cur{transition:none}.twmap .mk-pos,.twmap .app.is-local .mk-pos{transform:none}.twmap .app.is-local .mk-pos{transition:opacity ${m.fade}ms var(--eo)}.twmap .app.is-zoomed .mk-pos{transition:none}}
`;

export const mapCss = frame + map + panel + motion;
