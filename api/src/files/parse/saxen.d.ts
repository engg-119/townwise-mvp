// saxen ships no types. Only what parse/docx.ts uses: the non-namespace parser, its four events and stop.
declare module 'saxen' {
  export class Parser {
    constructor(options?: { proxy?: boolean });
    on(event: 'openTag', handler: (name: string, attrs: () => Record<string, string>, decode: (text: string) => string, selfClosing: boolean) => void): this;
    on(event: 'closeTag', handler: (name: string) => void): this;
    on(event: 'text', handler: (value: string, decode: (text: string) => string) => void): this;
    on(event: 'error', handler: (err: Error) => void): this;
    parse(xml: string): Error | undefined;
    /** Ends the parse after the current event. */
    stop(): void;
  }
}
