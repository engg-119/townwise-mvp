// libheif-js ships no types at its root. These are the few calls heic.web.ts makes on its JavaScript build.
declare module 'libheif-js' {
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    is_primary(): boolean;
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      done: (shown: { data: Uint8ClampedArray } | null) => void,
    ): void;
    free(): void;
  }
  export class HeifDecoder {
    decode(bytes: Uint8Array): HeifImage[];
  }
}
