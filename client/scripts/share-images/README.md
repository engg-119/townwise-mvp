# Share images

`og.html` (with the map from `src/marketing/map/geometry.ts`) and `public/favicon.svg` are the sources of `public/og/townwise.png`, `public/favicon-32.png`, `public/favicon.ico` and `public/apple-touch-icon.png`. Playwright is not a dependency of this repo, so install it outside the repo and pass its path. From the repository root:

```sh
npm install --prefix /tmp/pw playwright@1.62.1 && /tmp/pw/node_modules/.bin/playwright install chromium
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON client/scripts/share-images/render.mts /tmp/pw/node_modules/playwright
```

Commit the files it writes. `test/public/index-html.test.ts` checks their pixel sizes against `public/index.html`.
