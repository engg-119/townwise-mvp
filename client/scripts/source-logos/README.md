# Source logos

`sites.json` names every site the shipped sources cite (`{ host, name }`, the host without `www.`, written by hand and reviewed), and `fetch.mts` fetches each site's logo once, for the source chips (`src/portal/ui/SourceChip.tsx` and `src/marketing/SourceChip.web.tsx`). It reads the site's home page, then keeps the first PNG among its `apple-touch-icon` links, its PNG `<link rel="icon">` links and the largest PNG inside its `/favicon.ico`; SVG, BMP and anything else is refused, so that site shows a plain globe. It needs no dependency. From the repository root:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON client/scripts/source-logos/fetch.mts
```

It writes `client/assets/sources/{host}.png` and generates `client/src/portal/sources/logos.ts`. Commit both, after opening each PNG: delete any that is not the site's logo, then run `fetch.mts --manifest` (no network), so that site shows the globe. A logo changes only when someone runs the script again, and nothing fetches a logo at view time: the chips show the committed, same-origin files, so the web Content-Security-Policy needs no change.

A source on a host with no entry in `sites.json` (its parent domains down to two labels count, so `home.dartmouth.edu` finds `dartmouth.edu`) fails the run, naming the host, before anything is written. `fetch.mts --check` does only that and checks that `logos.ts` is what `sites.json` and the logo files make, with no network; `test/scripts/source-logos.test.ts` runs it, so a new source host fails the tests until it has a name.
