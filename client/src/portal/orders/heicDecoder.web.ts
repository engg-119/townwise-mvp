// libheif-js, fetched only when a browser can't draw a HEIC photo itself (heic.web.ts). The `import()` is what puts it
// in a file of its own in the web export; it stands alone here because jest runs no dynamic import, so tests replace
// this module.
export function loadHeicDecoder(): Promise<typeof import('libheif-js')> {
  return import('libheif-js');
}
