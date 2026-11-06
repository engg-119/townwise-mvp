// A MailTransport that records what it is asked to send, for startTownwiseServer({ mailTransport }) and the mailer's
// unit tests. Nothing leaves the process.
import { MailUnavailableError, type MailTransport, type OutboundEmail } from '../../src/mail/acs.ts';

export interface CapturingTransport extends MailTransport {
  /** Every message handed to send, in order, including those it then fails. */
  readonly sent: OutboundEmail[];
  /** The next `n` sends reject with `err` (default: MailUnavailableError upstream_status 500). */
  failNext(n?: number, err?: Error): void;
  /** The next send waits until release() is called: for checking what is written before the send settles. */
  hold(): { release(): void };
}

export function createCapturingTransport(): CapturingTransport {
  const sent: OutboundEmail[] = [];
  let failures: Error[] = [];
  let held: Promise<void> | null = null;
  return {
    sent,
    failNext: (n = 1, err = new MailUnavailableError('upstream_status', { status: 500 })) => {
      failures = [...failures, ...Array.from({ length: n }, () => err)];
    },
    hold: () => {
      let release = (): void => undefined;
      held = new Promise<void>((resolve) => { release = resolve; });
      return { release: () => { release(); } };
    },
    send: async (message) => {
      sent.push(message);
      const wait = held;
      held = null;
      if (wait !== null) await wait;
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
    },
  };
}
