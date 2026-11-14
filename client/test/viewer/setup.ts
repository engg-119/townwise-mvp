import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web';
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util';

// jsdom (the web project) has no TextEncoder, TextDecoder or DecompressionStream; the browsers the viewer supports
// (Chrome, Firefox, Safari 16.4+) have all three, so the tests take Node's.
if (typeof globalThis.TextEncoder !== 'function') globalThis.TextEncoder = NodeTextEncoder;
if (typeof globalThis.TextDecoder !== 'function') globalThis.TextDecoder = NodeTextDecoder as unknown as typeof TextDecoder;
if (typeof globalThis.DecompressionStream !== 'function') {
  globalThis.DecompressionStream = NodeDecompressionStream as unknown as typeof DecompressionStream;
}
