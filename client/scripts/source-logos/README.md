# Source logos

`sites.json` names every site the shipped sources cite (`{ host, name }`, the host without `www.`, written by hand and reviewed), and `fetch.mts` fetches each site's logo once, for the source chips (`src/portal/ui/SourceChip.tsx` and `src/marketing/SourceChip.web.tsx`). It reads the site's home page (`https://{host}/`, or `https://www.{host}/` when that fails; a generic `User-Agent`, a 10 second timeout, at most 256 KB), then keeps the first PNG among its `apple-touch-icon` links, its PNG `<link rel="icon">` links, the ICO files its icon links name and its `/favicon.ico` (the largest PNG inside an ICO), each icon at most 64 KB; SVG, BMP, JPEG and anything else is refused. In `logos.ts` a site with no logo of its own takes its nearest parent site's (`registrar.dartmouth.edu` shows `dartmouth.edu`'s), and a site with neither shows a plain globe. It needs no dependency. From the repository root:

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON client/scripts/source-logos/fetch.mts
```

It writes `client/assets/sources/{host}.png` and generates `client/src/portal/sources/logos.ts`, printing for each site the icon it kept or "no PNG icon, the globe". Commit both, after opening each PNG: delete any that is not the site's logo, then run `fetch.mts --manifest` (no network), so that site shows its parent site's logo or the globe. A logo changes only when someone runs the script again, and nothing fetches a logo at view time: the chips show the committed, same-origin files, so the web Content-Security-Policy needs no change.

A run fetches every site again, so review its diff file by file, as the first run was reviewed. It rewrites every logo, brings back a logo deleted by hand in an earlier review, and deletes the logo of a site that does not answer this time (a timeout or a server error reads the same as a site with no PNG icon). Delete again any logo refused before, restore from git any that went only because its site did not answer, then run `fetch.mts --manifest`.

A source on a host with no entry in `sites.json` (its parent domains down to two labels count, so `home.dartmouth.edu` finds `dartmouth.edu`) fails the run, naming the host, before anything is written. `fetch.mts --check` does only that and checks that `logos.ts` is what `sites.json` and the logo files make, with no network; `test/scripts/source-logos.test.ts` runs it, so a new source host fails the tests until it has a name.
