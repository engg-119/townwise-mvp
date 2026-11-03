import type { MagicLinkMessage } from '../../src/create-auth.ts';

export interface MailCapture {
  readonly messages: MagicLinkMessage[];
  sendMagicLink(message: MagicLinkMessage): Promise<void>;
  failNext(): void;
}

export function createMailCapture(): MailCapture {
  const messages: MagicLinkMessage[] = [];
  let fail = false;
  return {
    messages,
    sendMagicLink(message) {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('mail down'));
      }
      messages.push(message);
      return Promise.resolve();
    },
    failNext() {
      fail = true;
    },
  };
}

export function parseLink(url: string): { token: string; email: string } {
  const params = new URLSearchParams(new URL(url).hash.slice(1));
  return { token: params.get('token') ?? '', email: params.get('email') ?? '' };
}
