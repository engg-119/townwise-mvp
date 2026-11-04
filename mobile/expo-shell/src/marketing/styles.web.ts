import { theme } from '../theme';

// The marketing pages' CSS, from the design mockups, with colors, fonts and curves from the theme.
// Shared chrome first, then each text page under its own root class (.pg-about and so on): screens
// stay mounted in the stack, so every rule applies document-wide and page rules must not collide.

const c = theme.color;
const easeOut = `cubic-bezier(${theme.motion.easeOut.join(',')})`;

const chrome = `
.tw{--ground:${c.ground};--panel:${c.panel};--raised:${c.raised};--state:${c.state};--border:${c.border};--line:${c.line};--white:${c.white};--text2:${c.text2};--text3:${c.text3};--mint:${c.mint};--eo:${easeOut};--sans:${theme.font.sans};--mono:${theme.font.mono};position:absolute;inset:0;overflow-x:hidden;overflow-y:auto;background:var(--ground);color:var(--white);font-family:var(--sans);font-size:17px;line-height:28px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.tw *,.tw *::before,.tw *::after{box-sizing:border-box}
.tw h1,.tw h2,.tw h3,.tw p,.tw ul,.tw ol{margin:0}
.tw ul,.tw ol{padding:0;list-style:none}
:where(.tw) a{color:var(--white)}
:where(.tw) a:hover{color:var(--mint)}
.tw a{text-underline-offset:3px}
.tw :focus-visible{outline:2px solid var(--mint);outline-offset:2px}
.tw :focus:not(:focus-visible){outline:none}
.tw [tabindex="-1"]:focus{outline:none}
.skip{position:absolute;left:16px;top:-80px;z-index:20;background:var(--mint);color:var(--ground);padding:12px 16px;font-weight:600;font-size:14px;line-height:20px;text-decoration:none}
.skip:focus{top:12px;color:var(--ground)}

.wrap{box-sizing:content-box;max-width:1280px;margin-inline:auto;padding-inline:clamp(16px,5.55vw,80px)}
.tw .wrap{box-sizing:content-box}
.g12{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));column-gap:20px}
.c-l{grid-column:1/4}.c-r{grid-column:4/13}
@media (min-width:641px) and (max-width:1023px){.wrap{padding-inline:32px}.g12{grid-template-columns:repeat(8,minmax(0,1fr))}.c-l,.c-r{grid-column:1/-1}}
@media (max-width:640px){.wrap{padding-inline:16px}.g12{grid-template-columns:repeat(4,minmax(0,1fr));column-gap:16px}.c-l,.c-r{grid-column:1/-1}}

.eyebrow{font-family:var(--mono);font-weight:400;font-size:12px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--text3)}
.h2{font-size:40px;line-height:44px;font-weight:600;letter-spacing:-.02em;text-wrap:balance}
.h3{font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.01em;text-wrap:balance}
@media (max-width:1023px){.h2{font-size:32px;line-height:36px}}
@media (max-width:640px){.tw{font-size:16px;line-height:24px}.h2{font-size:28px;line-height:32px}.h3{font-size:20px;line-height:24px}}
.chip{font-family:var(--mono);font-size:12px;line-height:16px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--text2);border:1px dashed var(--line);padding:1px 5px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.tag{font-family:var(--mono);font-size:12px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--text2);border:1px solid var(--line);padding:3px 6px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.tag-prog::before{content:"";width:6px;height:6px;background:var(--mint)}
.tag-plan::before{content:"";width:6px;height:6px;border:1px solid var(--line)}

.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;background:var(--white);color:var(--ground);font-family:var(--sans);font-weight:600;font-size:15px;line-height:20px;text-decoration:none;border:0;border-radius:0;white-space:nowrap;transition:background-color 150ms ease,transform 160ms var(--eo)}
.btn:hover{background:var(--text2);color:var(--ground)}
.btn:active{transform:scale(.97)}
.tl{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;color:var(--white);font-size:14px;line-height:20px;font-weight:500;text-decoration:underline;text-decoration-color:var(--line)}
.tl:hover{color:var(--mint);text-decoration-color:var(--mint)}

.nav{border-bottom:1px solid var(--border)}
.nav-in{display:flex;flex-wrap:wrap;align-items:center;column-gap:48px;min-height:64px}
.wm{display:inline-flex;align-items:center;min-height:44px;font-weight:600;font-size:18px;line-height:24px;letter-spacing:-.01em;color:var(--white);text-decoration:none}
.wm:hover{color:var(--white)}
.nav-links{display:flex;flex-wrap:wrap;column-gap:24px}
.nav-links a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;font-size:14px;line-height:20px;font-weight:500;color:var(--text2);text-decoration:none}
.nav-links a:hover{color:var(--white)}
.nav-act{margin-left:auto;display:flex;align-items:center;gap:20px}
@media (max-width:899px){.nav-in{column-gap:16px}.nav-links{order:3;width:100%;column-gap:20px;border-top:1px solid var(--border)}}
@media (max-width:640px){.nav-links{display:none}.nav-act{gap:12px}.nav-act .btn{font-size:14px;padding:0 14px}}

.ft{border-top:1px solid var(--border);padding-top:64px}
.ft-inner{container-type:inline-size}
.ft-cols{row-gap:32px}
.ft-c1{grid-column:1/5;display:grid;gap:8px;align-content:start}
.ft-cn{grid-column:span 2;display:grid;gap:4px;align-content:start}
@media (max-width:1023px){.ft-c1{grid-column:1/-1}}
.ft-by{font-size:14px;line-height:20px;color:var(--text2);max-width:420px}
.ft-cn a{display:inline-flex;align-items:center;min-height:44px;min-width:44px;font-size:14px;line-height:20px;color:var(--text2);text-decoration:none}
.ft-cn a:hover{color:var(--white);text-decoration:underline}
.ft-dec{margin-top:40px}
.ft-bot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 24px;padding:24px 0 32px;font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3)}
.tw .ft-word{--adv:3.959;--cap:0.72;--base:0.14;--pad:0.02em;display:flex;justify-content:space-between;align-items:flex-end;box-sizing:content-box;font-size:calc(98cqi / var(--adv));height:calc(var(--cap) * 1em);padding-top:var(--pad);overflow:clip;line-height:1;font-family:${theme.font.wordmark};font-weight:700;font-stretch:75%;letter-spacing:0;color:var(--white)}
.ft-word span{display:block;line-height:1;margin-bottom:calc(var(--base) * -1em);transition:transform 700ms var(--eo)}
@media screen and (prefers-reduced-motion:no-preference){.ft.is-armed:not(.is-in) .ft-word span{transform:translateY(100%);transition:none}}
.ft.is-now .ft-word span{transition:none}

@media (prefers-reduced-motion:reduce){.ft-word span{transform:none;transition:none}.btn:active{transform:none}}
`;

const about = `
.pg-about .ab-hero{padding-block:80px 96px}
.pg-about .ab-hero .g12{row-gap:32px}
.pg-about .h1{font-size:34px;line-height:40px;font-weight:600;letter-spacing:-.025em;text-wrap:balance;margin-top:16px}
@media (min-width:641px){.pg-about .h1{font-size:44px;line-height:48px}}
@media (min-width:1024px){.pg-about .h1{font-size:56px;line-height:60px}}
.pg-about .prose{display:grid;gap:20px;max-width:66ch}
.pg-about .prose p{color:var(--text2);text-wrap:pretty}
.pg-about .lede{font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.01em;color:var(--white);text-wrap:balance;max-width:34ch}
@media (max-width:640px){.pg-about .lede{font-size:20px;line-height:24px}.pg-about .ab-hero{padding-block:48px 64px}}
.pg-about .sec{border-top:1px solid var(--border);padding-block:96px}
@media (max-width:640px){.pg-about .sec{padding-block:64px}}
.pg-about .sec .g12{row-gap:32px;align-items:start}
.pg-about .h2s{font-size:28px;line-height:32px;font-weight:600;letter-spacing:-.02em;text-wrap:balance}
@media (max-width:640px){.pg-about .h2s{font-size:24px;line-height:28px}}
.pg-about .build{display:grid;border-top:1px solid var(--border);counter-reset:b;max-width:760px}
.pg-about .build>li{display:grid;grid-template-columns:48px minmax(0,1fr);gap:0 12px;padding:20px 0;border-bottom:1px solid var(--border);counter-increment:b}
.pg-about .build>li::before{content:counter(b,decimal-leading-zero);font-family:var(--mono);font-size:12px;line-height:28px;color:var(--text3)}
.pg-about .build>li.nx{counter-increment:none}
.pg-about .build>li.nx::before{content:""}
.pg-about .build p{color:var(--text2);max-width:62ch;text-wrap:pretty}
.pg-about .build strong{color:var(--white);font-weight:600}
.pg-about .stages table{width:100%;border-collapse:collapse;text-align:left}
.pg-about .stages thead th{font-family:var(--mono);font-weight:400;font-size:12px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--text3);padding:0 20px 12px 0;border-bottom:1px solid var(--border);vertical-align:bottom}
.pg-about .stages tbody th,.pg-about .stages tbody td{vertical-align:top;padding:24px 20px 24px 0;border-bottom:1px solid var(--border);font-weight:400;text-align:left}
.pg-about .stages tbody th{font-weight:600;color:var(--white);width:22%}
.pg-about .stages tbody td:nth-child(2){width:28%;color:var(--text2);text-wrap:pretty}
.pg-about .stages tbody td:nth-child(3){width:50%;color:var(--text2)}
.pg-about .st-c{display:grid;gap:12px;justify-items:start;max-width:56ch}
.pg-about .st-c p{text-wrap:pretty}
.pg-about .frozen{margin-top:32px;max-width:66ch;color:var(--text2);text-wrap:pretty}
@media (max-width:899px){
.pg-about .stages thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.pg-about .stages table,.pg-about .stages tbody,.pg-about .stages tr,.pg-about .stages tbody th,.pg-about .stages tbody td{display:block;width:auto}
.pg-about .stages tr{padding:20px 0;border-bottom:1px solid var(--border);display:grid;gap:12px}
.pg-about .stages tbody th,.pg-about .stages tbody td{padding:0;border-bottom:0}
.pg-about .stages tbody th,.pg-about .stages tbody td:nth-child(2),.pg-about .stages tbody td:nth-child(3){width:auto}
.pg-about .stages tbody td::before{content:attr(data-l);display:block;margin-bottom:4px;font-family:var(--mono);font-size:12px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--text3)}
}
.pg-about .qs{display:grid;border-top:1px solid var(--border);counter-reset:q;max-width:760px}
.pg-about .qs>li{display:grid;grid-template-columns:48px minmax(0,1fr);gap:0 12px;padding:20px 0;border-bottom:1px solid var(--border);counter-increment:q;font-size:22px;line-height:28px;font-weight:500;letter-spacing:-.01em;color:var(--white);text-wrap:pretty}
.pg-about .qs>li::before{content:counter(q,decimal-leading-zero);font-family:var(--mono);font-size:12px;line-height:28px;font-weight:400;letter-spacing:0;color:var(--text3)}
@media (max-width:640px){.pg-about .qs>li{font-size:18px;line-height:24px}.pg-about .qs>li::before{line-height:24px}}
.pg-about .talk{display:grid;gap:20px;justify-items:start}
.pg-about .talk .big{font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.01em;max-width:36ch;text-wrap:balance}
.pg-about .talk-act{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px}
@media (max-width:640px){.pg-about .talk .big{font-size:20px;line-height:24px}.pg-about .talk-act .btn{flex:1 1 100%}}
`;

const privacy = `
.pg-privacy .sub{font-size:16px;line-height:24px;color:var(--text2);text-wrap:pretty}
.pg-privacy .h1{font-size:34px;line-height:40px;font-weight:600;letter-spacing:-.025em}
@media (min-width:641px){.pg-privacy .h1{font-size:40px;line-height:44px}}
@media (min-width:800px){.pg-privacy .h1{font-size:52px;line-height:56px}}
.pg-privacy .hd{padding-block:56px 64px;row-gap:32px;align-items:end}
.pg-privacy .hd-l{grid-column:1/8;min-width:0;display:grid;gap:16px;align-content:start}
.pg-privacy .hd-r{grid-column:9/13;min-width:0;display:grid;gap:4px;align-content:start}
@media (max-width:1219px){.pg-privacy .hd{align-items:start}.pg-privacy .hd-l,.pg-privacy .hd-r{grid-column:1/-1}.pg-privacy .hd-r{max-width:640px}}
@media (max-width:640px){.pg-privacy .hd{padding-block:32px 40px}}
.pg-privacy .toc{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));column-gap:20px}
.pg-privacy .toc a{display:inline-flex;align-items:center;min-height:44px;font-size:14px;line-height:20px;color:var(--text2);text-decoration:none}
.pg-privacy .toc a:hover{color:var(--white);text-decoration:underline}
.pg-privacy .sec{border-top:1px solid var(--border);padding-block:56px}
@media (max-width:640px){.pg-privacy .sec{padding-block:40px}}
.pg-privacy .sec .g12{row-gap:16px;align-items:start}
.pg-privacy .prose{max-width:600px;min-width:0;display:grid;gap:16px;align-content:start;color:var(--text2)}
.pg-privacy .prose p{text-wrap:pretty}
.pg-privacy .prose strong{color:var(--white);font-weight:600}
.pg-privacy .prose a{color:var(--white);text-decoration:underline;text-decoration-color:var(--line)}
.pg-privacy .prose a:hover{color:var(--mint);text-decoration-color:var(--mint)}
.pg-privacy .prose code,.pg-privacy .tbl code{font-family:var(--mono);font-size:13px;line-height:20px;color:var(--white);word-break:break-word}
.pg-privacy .bul{display:grid;gap:12px}
.pg-privacy .bul li{position:relative;padding-left:20px;text-wrap:pretty}
.pg-privacy .bul li::before{content:"";position:absolute;left:0;top:11px;width:6px;height:6px;background:var(--mint)}
@media (max-width:640px){.pg-privacy .bul li::before{top:9px}}
.pg-privacy .tbl{overflow-x:auto;border:1px solid var(--border);background:var(--panel)}
.pg-privacy .tbl table{width:100%;min-width:480px;border-collapse:collapse;font-size:14px;line-height:20px;color:var(--text2)}
.pg-privacy .tbl.wide table{min-width:640px}
.pg-privacy .tbl th,.pg-privacy .tbl td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--border);font-weight:400}
.pg-privacy .tbl tr:last-child td{border-bottom:0}
.pg-privacy .tbl thead th{font-family:var(--mono);font-size:12px;line-height:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--text3);background:var(--raised)}
.pg-privacy .tbl td:first-child{color:var(--white)}
.pg-privacy .tbl:focus-visible{outline:2px solid var(--mint);outline-offset:2px}
.pg-privacy .sum{background:var(--panel)}
`;

const terms = `
.pg-terms .h1{font-size:34px;line-height:40px;font-weight:600;letter-spacing:-.025em;text-wrap:balance}
@media (min-width:641px){.pg-terms .h1{font-size:40px;line-height:44px}}
@media (min-width:800px){.pg-terms .h1{font-size:52px;line-height:56px}}
.pg-terms .ph{padding-block:48px 40px;border-bottom:1px solid var(--border)}
.pg-terms .ph .h1w{margin-top:16px}
.pg-terms .ph .eff{margin-top:20px;color:var(--text2)}
.pg-terms .doc{padding-block:48px 96px;row-gap:40px}
.pg-terms .toc{grid-column:1/4;align-self:start;position:sticky;top:16px}
.pg-terms .toc ol{display:grid;margin-top:12px;border-top:1px solid var(--border)}
.pg-terms .toc li{border-bottom:1px solid var(--border)}
.pg-terms .toc a{display:flex;gap:12px;align-items:baseline;min-height:44px;padding:8px 0;font-size:14px;line-height:20px;color:var(--text2);text-decoration:none}
.pg-terms .toc a:hover{color:var(--mint)}
.pg-terms .sn{font-family:var(--mono);font-size:12px;line-height:16px;color:var(--text3);font-weight:400;letter-spacing:0;min-width:24px;display:inline-block}
.pg-terms .art{grid-column:4/13;min-width:0}
.pg-terms .sec{max-width:68ch;padding:32px 0;border-top:1px solid var(--border);scroll-margin-top:16px}
.pg-terms .sec:first-child{border-top:0;padding-top:0}
.pg-terms .sec .h3{display:flex;gap:12px;align-items:baseline;color:var(--white)}
.pg-terms .prose{margin-top:16px;display:grid;gap:16px;color:var(--text2);text-wrap:pretty}
.pg-terms .prose a{color:var(--white);text-decoration-color:var(--line)}
.pg-terms .prose a:hover{color:var(--mint);text-decoration-color:var(--mint)}
.pg-terms .bl{display:grid;gap:8px}
.pg-terms .bl li{position:relative;padding-left:20px}
.pg-terms .bl li::before{content:"";position:absolute;left:0;top:11px;width:6px;height:6px;background:var(--mint)}
@media (max-width:1023px){.pg-terms .toc{grid-column:1/-1;position:static}.pg-terms .art{grid-column:1/-1}.pg-terms .toc ol{grid-template-columns:repeat(2,minmax(0,1fr));column-gap:24px}}
@media (max-width:640px){.pg-terms .toc ol{grid-template-columns:minmax(0,1fr)}.pg-terms .ph{padding-block:32px 24px}.pg-terms .doc{padding-block:32px 64px}}
`;

const security = `
.pg-security .hd{padding-block:20px;row-gap:20px;align-items:end;align-items:last baseline}
.pg-security .hd-l{grid-column:1/8;min-width:0}
.pg-security .h1w{margin-top:16px}
.pg-security .h1{font-size:34px;line-height:40px;font-weight:600;letter-spacing:-.025em}
@media (min-width:641px){.pg-security .h1{font-size:40px;line-height:44px}}
@media (min-width:800px){.pg-security .h1{font-size:52px;line-height:56px}}
@media (min-width:1220px) and (max-width:1429px){.pg-security .h1{font-size:44px;line-height:48px}}
@media (max-width:1219px){.pg-security .hd{align-items:start}.pg-security .hd-l{grid-column:1/-1}}
@media (max-width:640px){.pg-security .hd{padding-block:12px 16px;row-gap:12px}.pg-security .h1w{margin-top:12px}}
.pg-security .pg{padding-bottom:64px}
.pg-security .updated{margin-top:12px}
.pg-security .settings{margin-top:8px}
.pg-security .sec{border-top:1px solid var(--border);padding-block:96px}
@media (max-width:640px){.pg-security .sec{padding-block:64px}}
.pg-security .sec .g12{row-gap:24px;align-items:start}
.pg-security .lead-l{display:grid;gap:8px;align-content:start}
.pg-security .prose{display:grid;gap:20px;align-content:start;min-width:0}
.pg-security .prose p{max-width:68ch;color:var(--text2);text-wrap:pretty}
.pg-security .prose p.lede{font-size:22px;line-height:32px;color:var(--white);max-width:60ch}
@media (max-width:640px){.pg-security .prose p.lede{font-size:20px;line-height:28px}}
.pg-security .pts{display:grid;border-top:1px solid var(--border);min-width:0}
.pg-security .pts li{padding:16px 0;border-bottom:1px solid var(--border)}
.pg-security .pts li p{max-width:68ch;color:var(--text2);text-wrap:pretty}
.pg-security .pts li strong{color:var(--white);font-weight:600}
.pg-security .pts code,.pg-security .prose code{font-family:var(--mono);font-size:.82em}
`;

// Sign-in (src/auth/SignInFrame.web.tsx). The card holds React Native views, so it stacks them in a flex
// column (the mockup's grid with the same 16px gap) where their own alignSelf applies.
const signIn = `
.pg-signin .hd{padding-block:48px 64px;row-gap:32px;align-items:start}
.pg-signin .hd-l{grid-column:1/8;min-width:0;display:grid;gap:16px;align-content:start}
.pg-signin .hd-r{grid-column:9/13;min-width:0}
.pg-signin .c-all{grid-column:1/-1}
@media (max-width:1219px){.pg-signin .hd-l,.pg-signin .hd-r{grid-column:1/-1}.pg-signin .hd-r{max-width:480px}}
@media (max-width:640px){.pg-signin .hd{padding-block:24px 48px;row-gap:24px}}
.pg-signin .wm-row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px}
.pg-signin .h1{font-size:34px;line-height:40px;font-weight:600;letter-spacing:-.025em}
@media (min-width:641px){.pg-signin .h1{font-size:40px;line-height:44px}}
@media (min-width:800px){.pg-signin .h1{font-size:52px;line-height:56px}}
@media (min-width:1220px) and (max-width:1429px){.pg-signin .h1{font-size:44px;line-height:48px}}
.pg-signin .sub{font-size:16px;line-height:24px;color:var(--text2);text-wrap:pretty}
.pg-signin .card{display:flex;flex-direction:column;gap:16px;padding:24px;background:var(--panel);border:1px solid var(--border);border-radius:${theme.radius.frame}px}
@media (max-width:640px){.pg-signin .card{padding:20px 16px}}
.pg-signin .access{display:flex;flex-wrap:wrap;align-items:center;gap:0 16px;border-top:1px solid var(--border);padding-block:16px 8px}
.pg-signin .access p{color:var(--text2)}
.pg-signin .legal-row{display:flex;flex-wrap:wrap;gap:0 8px;align-items:center}
.pg-signin .legal-row li{display:inline-flex;align-items:center}
.pg-signin .legal-row li+li::before{content:"\\00b7";color:var(--text3);margin-right:8px}
`;

export const css = chrome + about + privacy + terms + security + signIn;
