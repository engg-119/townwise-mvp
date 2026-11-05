import { theme } from '../theme';

// The homepage's CSS (ConsoleV2.dc.html), rendered by Home.web.tsx so it ships in the / route chunk with the
// page, not in the shared chunk every route loads. Colors, fonts and --eo come from the marketing chrome (.tw);
// every rule sits under .pg-home, because screens stay mounted in the stack.
// The lead sits above the map, so the H1 keeps the mockup's in-flow steps (40px, 52px from 800px); its 64 to
// 92px steps fitted the map's empty corner. Each sentence rises once from its line mask; with reduced motion it
// fades. Sections rise 16px as they enter, or only fade.
// How it works: from 1024px with an observer (.is-pin) the steps scroll in 560px slots beside one sticky
// stage. Each visual's parts return to their start only after the 120ms fade out (0s, 150ms delay), so every
// enter replays from the start. All movement sits under no-preference: reduced motion keeps only the fades,
// with the lines fully drawn and in place.
const easeInOut = `cubic-bezier(${theme.motion.easeInOut.join(',')})`;

export const homeCss = `
.pg-home .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.pg-home .body{color:var(--text2);text-wrap:pretty}
.pg-home .btn-o{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;background:transparent;color:var(--white);font-family:var(--sans);font-weight:600;font-size:15px;line-height:20px;text-decoration:none;border:1px solid var(--line);border-radius:0;white-space:nowrap;transition:border-color 150ms ease,transform 160ms var(--eo)}
.pg-home .btn-o:hover{color:var(--white);border-color:var(--white)}
.pg-home .btn-o:active{transform:scale(.97)}

.pg-home .hero{padding-bottom:96px}
.pg-home .hd{display:grid;gap:16px;justify-items:start;padding-block:40px 32px}
.pg-home .h1{font-size:40px;line-height:44px;font-weight:600;letter-spacing:-.025em}
@media (min-width:800px){.pg-home .h1{font-size:52px;line-height:56px}}
.pg-home .h1 .ln{display:block;overflow:hidden;padding-bottom:.08em;margin-bottom:-.08em}
.pg-home .h1 .ln>span{display:block;text-wrap:balance}
.pg-home .sub{max-width:680px;font-size:17px;line-height:28px;color:var(--text2);text-wrap:pretty}
.pg-home .cta-row{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
@media (max-width:640px){.pg-home .hero{padding-bottom:64px}.pg-home .hd{gap:12px;padding-block:24px}.pg-home .sub{font-size:16px;line-height:24px}.pg-home .cta-row{width:100%}.pg-home .cta-row>a{flex:1 1 auto}}
@keyframes twRise{from{transform:translateY(100%)}to{transform:none}}
@keyframes twIn{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:no-preference){.pg-home .h1.is-rise .ln>span{animation:twRise 600ms var(--eo) both}.pg-home .h1.is-rise .ln+.ln>span{animation-delay:80ms}}
@media (prefers-reduced-motion:reduce){.pg-home .h1.is-rise .ln>span{animation:twIn 300ms var(--eo) both}}

.pg-home .sec{border-top:1px solid var(--border);padding-block:96px}
@media (max-width:640px){.pg-home .sec{padding-block:64px}}
.pg-home .sec .g12{row-gap:32px;align-items:baseline}
.pg-home .lead-l{display:grid;gap:12px;align-content:start}
.pg-home .probs,.pg-home .who{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:32px 20px;counter-reset:p}
.pg-home .probs>li,.pg-home .who>li{display:grid;gap:8px;align-content:start;border-top:1px solid var(--border);padding-top:16px}
.pg-home .probs>li::before{counter-increment:p;content:counter(p,decimal-leading-zero);font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}

.pg-home{--eio:${easeInOut}}
.pg-home .hw{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
.pg-home .steps{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;align-items:start}
@media (min-width:641px){.pg-home .steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
.pg-home .hw-s{display:grid;gap:12px;align-content:start}
.pg-home .step{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--border)}
.pg-home .step-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;min-height:44px;padding:6px 12px;border-bottom:1px solid var(--border)}
.pg-home .step-no{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.pg-home .step-body{display:grid;gap:12px;padding:16px;align-content:start}
.pg-home .step-body .h3,.pg-home .step-body p{transition:color 200ms ease}
.pg-home .step-body p{font-size:14px;line-height:20px;color:var(--text2);text-wrap:pretty}
.pg-home .step-body .lbl{font-family:var(--mono);font-size:12px;color:var(--text3);text-transform:uppercase;letter-spacing:.04em}
.pg-home .step-body .hw-src{display:flex;flex-wrap:wrap;align-items:center;column-gap:12px;font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.pg-home .hw-src a{display:inline-flex;align-items:center;min-height:44px;color:var(--text2)}
.pg-home .hw-src a:hover{color:var(--mint)}
.pg-home .hw.is-pin{grid-template-columns:repeat(12,minmax(0,1fr));column-gap:20px}
.pg-home .hw.is-pin .steps{grid-column:1/6;grid-template-columns:minmax(0,1fr);gap:0}
.pg-home .hw.is-pin .hw-s{min-height:560px;align-content:center}
.pg-home .hw.is-pin .hw-s:not(.is-act) .h3{color:var(--text2)}
.pg-home .hw.is-pin .hw-s:not(.is-act) .step-body p{color:var(--text3)}
.pg-home .hw-stc{grid-column:7/13}
.pg-home .hw-st{position:sticky;top:32px;height:520px;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--panel);border:1px solid var(--border)}
.pg-home .hw-hd{display:flex;align-items:center;min-height:48px;padding:0 16px;border-bottom:1px solid var(--border)}
.pg-home .hw-pg{display:flex;gap:20px;font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.pg-home .hw-pg li{position:relative;padding-block:6px;transition:color 200ms ease}
.pg-home .hw-pg li::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--mint);opacity:0;transition:opacity 200ms ease}
.pg-home .hw-pg li.is-cur{color:var(--mint)}
.pg-home .hw-pg li.is-cur::after{opacity:1}
.pg-home .hw-vz{position:relative;min-height:0}
.pg-home .hw-vz>.hv{position:absolute;inset:0;padding:24px 28px}
.pg-home .hv{display:grid;gap:16px;align-content:center;opacity:0;transition:opacity 120ms ease}
.pg-home .hv.is-on{opacity:1;transition:opacity 150ms var(--eo)}
.pg-home .hv-in{background:var(--panel);border:1px solid var(--border);padding:16px}
.pg-home .hv-cap{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.pg-home .hv-k{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text2)}
.pg-home .v-ch{display:block;width:100%;height:auto;aspect-ratio:400/200;overflow:visible}
.pg-home .v-grid{fill:none;stroke:var(--border);stroke-width:1}
.pg-home .v1-l,.pg-home .v4-l{display:grid;gap:10px}
.pg-home .v1-l li{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:center;gap:16px;padding:12px 14px;background:var(--raised);border:1px solid var(--border);opacity:0;transition:opacity 0s 150ms}
.pg-home .hv.is-on .v1-l li{opacity:1;transition:opacity 280ms var(--eo) calc(100ms + var(--n) * 50ms)}
.pg-home .v1-d{display:grid;font-family:var(--mono);font-variant-numeric:tabular-nums}
.pg-home .v1-m{font-size:12px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--text2)}
.pg-home .v1-dd{font-size:24px;line-height:28px;font-weight:500;color:var(--white)}
.pg-home .v1-t{font-size:14px;line-height:20px;color:var(--white)}
.pg-home .v2-band{fill:var(--mint);fill-opacity:.16;stroke:none;opacity:0;transition:opacity 0s 150ms}
.pg-home .hv.is-on .v2-band{opacity:1;transition:opacity 250ms var(--eo) 550ms}
.pg-home .v2-line,.pg-home .v3-line{fill:none;stroke:var(--mint);stroke-width:2;stroke-linejoin:round}
.pg-home .v2-tags{display:flex;flex-wrap:wrap;gap:6px}
.pg-home .v2-tags li{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text2);border:1px solid var(--line);padding:3px 6px;opacity:0;transition:opacity 0s 150ms}
.pg-home .hv.is-on .v2-tags li{opacity:1;transition:opacity 200ms var(--eo) calc(550ms + var(--n) * 50ms)}
.pg-home .v3-dot{fill:var(--text2);opacity:0;transition:opacity 0s 150ms}
.pg-home .hv.is-on .v3-dot{opacity:1;transition:opacity 200ms var(--eo) calc(80ms + var(--n) * 30ms)}
.pg-home .v4-r{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:12px 14px;background:var(--raised);border:1px solid var(--border);font-family:var(--mono);font-size:14px;line-height:20px;color:var(--text2);opacity:0;transition:opacity 0s 150ms}
.pg-home .hv.is-on .v4-r{opacity:1;transition:opacity 200ms var(--eo) calc(100ms + var(--n) * 60ms)}
@media (prefers-reduced-motion:no-preference){.pg-home .v1-l li{transform:translateY(-12px);transition:opacity 0s 150ms,transform 0s 150ms}.pg-home .hv.is-on .v1-l li{transform:none;transition:opacity 280ms var(--eo) calc(100ms + var(--n) * 50ms),transform 280ms var(--eo) calc(100ms + var(--n) * 50ms)}.pg-home .v2-line{stroke-dasharray:1 1;stroke-dashoffset:1;transition:stroke-dashoffset 0s 150ms}.pg-home .hv.is-on .v2-line{stroke-dashoffset:0;transition:stroke-dashoffset 500ms var(--eo) 100ms}.pg-home .v3-line{transform-box:fill-box;transform-origin:50% 50%;transform:translateY(14px) scaleY(.5);transition:transform 0s 150ms}.pg-home .hv.is-on .v3-line{transform:none;transition:transform 400ms var(--eio) 500ms}.pg-home .v4-r{opacity:1;clip-path:inset(0 100% 0 0);transition:clip-path 0s 150ms}.pg-home .hv.is-on .v4-r{clip-path:inset(0 0 0 0);transition:clip-path 280ms var(--eo) calc(100ms + var(--n) * 60ms)}}
.pg-home .slot{border:1px dashed var(--line);padding:2px 6px;color:var(--text2)}
.pg-home .after{margin-top:32px;color:var(--text2)}
@media (max-width:640px){.pg-home .step-body p,.pg-home .v1-t{font-size:16px;line-height:24px}}

.pg-home .feat{display:grid;border-top:1px solid var(--border)}
.pg-home .feat>li{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,6fr) auto;gap:8px 20px;align-items:baseline;padding:16px 0;border-bottom:1px solid var(--border)}
.pg-home .feat .fn{font-weight:600;color:var(--white)}
.pg-home .feat .fd{color:var(--text2);text-wrap:pretty}
@media (max-width:640px){.pg-home .feat>li{grid-template-columns:minmax(0,1fr) auto}.pg-home .feat .fd{grid-column:1/-1;grid-row:2}}
.pg-home .ill{margin-top:32px;background:var(--panel);border:1px solid var(--border)}
.pg-home .ill-h{padding:10px 12px;border-bottom:1px solid var(--border)}
.pg-home .ill-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 20px;padding:16px 12px;font-family:var(--mono);font-size:14px;line-height:20px;color:var(--text2)}
.pg-home .ill-row>span{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px}
.pg-home .twl{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.pg-home .twl li{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text2);border:1px solid var(--line);padding:3px 6px}
.pg-home .who-foot{display:grid;gap:16px;justify-items:start;margin-top:48px}
.pg-home .who-foot .big{font-size:22px;line-height:28px;font-weight:600;color:var(--white)}
.pg-home .about .h3{color:var(--text2);font-weight:500}
.pg-home .about h2 a{display:inline-flex;align-items:center;gap:8px;min-height:44px;color:var(--text3);text-decoration:none}
.pg-home .about h2 a:hover{color:var(--mint)}
.pg-home .faq{display:grid;border-top:1px solid var(--border)}
.pg-home .faq-i{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,5fr);gap:12px 20px;padding:28px 0;border-bottom:1px solid var(--border)}
.pg-home .faq-i p{color:var(--text2);text-wrap:pretty}
@media (max-width:640px){.pg-home .faq-i p a{position:relative;z-index:1;padding-block:13px}}
@media (max-width:1023px){.pg-home .faq-i{grid-template-columns:minmax(0,1fr)}}
.pg-home .fin{background:var(--panel)}
.pg-home .fin-l{grid-column:1/8}
.pg-home .fin-r{grid-column:9/13;display:grid;gap:16px;justify-items:start}
@media (max-width:1023px){.pg-home .fin-l,.pg-home .fin-r{grid-column:1/-1}}

.pg-home .rv{transition:opacity 500ms var(--eo),transform 600ms var(--eo)}
@media (prefers-reduced-motion:no-preference){.pg-home .rv.is-hid{opacity:0;transform:translateY(16px);transition:none}}
@media (prefers-reduced-motion:reduce){.pg-home .rv{transition:opacity 400ms var(--eo)}.pg-home .rv.is-hid{opacity:0;transition:none}.pg-home .btn-o:active{transform:none}}
.pg-home .rv.is-now{transition:none}
`;
