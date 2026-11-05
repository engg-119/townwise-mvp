import type { Server } from 'node:http';

import type { Logger } from './logger.ts';
import { onUnhandledRejection } from './unhandledRejection.ts';

const HOOK_TIMEOUT_MS = 2000;
const IDLE_SWEEP_MS = 250;
const DRAIN_MARGIN_MS = 5000;

interface ShutdownHookLike {
  readonly name: string;
  close(): Promise<void>;
}

export interface ShutdownController {
  shutdown(reason: string, exitCode?: number): Promise<void>;
  installProcessHandlers(): void;
}

function drainHttp(server: Server, deadlineMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const sweep = setInterval(() => { server.closeIdleConnections(); }, IDLE_SWEEP_MS);
    const deadline = setTimeout(() => { server.closeAllConnections(); }, Math.max(0, deadlineMs));
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(sweep);
      clearTimeout(deadline);
      resolve();
    };
    server.close(() => { done(); });
    server.closeIdleConnections();
  });
}

async function runHook(logger: Logger, hook: ShutdownHookLike): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error('hook timed out')); }, HOOK_TIMEOUT_MS);
  });
  try {
    await Promise.race([hook.close(), timeout]);
  } catch (err) {
    logger.error({ hook: hook.name, err }, 'shutdown hook failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createShutdownController(deps: {
  shutdownTimeoutMs: number;
  logger: Logger;
  hooks: readonly ShutdownHookLike[];
  exit: (code: number) => void;
  getServer: () => Server | undefined;
}): ShutdownController {
  let pending: Promise<void> | undefined;
  let removeHandlers: (() => void) | undefined;

  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    if (pending !== undefined) return pending;
    pending = run(reason, exitCode);
    return pending;
  };

  const installProcessHandlers = (): void => {
    if (removeHandlers !== undefined) return;
    const onTerm = (): void => { void shutdown('SIGTERM', 0); };
    const onInt = (): void => { void shutdown('SIGINT', 0); };
    const onUncaught = (err: Error): void => {
      deps.logger.fatal({ err }, 'uncaught exception');
      void shutdown('uncaughtException', 1);
    };
    const onRejection = (reason: unknown): void => {
      deps.logger.error({ err: reason }, 'unhandled rejection');
      if (onUnhandledRejection(reason) === 'shutdown') void shutdown('unhandledRejection', 1);
    };
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
    removeHandlers = () => {
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onRejection);
      removeHandlers = undefined;
    };
  };

  async function run(reason: string, exitCode: number): Promise<void> {
    let finished = false;
    // The hard timer sets this from another turn, so the reads go through a function.
    const hasFinished = (): boolean => finished;
    const finish = (code: number): void => {
      if (hasFinished()) return;
      finished = true;
      removeHandlers?.();
      deps.exit(code);
    };

    const hard = setTimeout(() => {
      deps.logger.fatal({ reason }, 'shutdown timed out');
      const server = deps.getServer();
      if (server !== undefined) {
        server.closeAllConnections();
        if (server.listening) server.close();
      }
      finish(exitCode || 1);
    }, deps.shutdownTimeoutMs);
    hard.unref();

    const server = deps.getServer();
    if (server?.listening === true) await drainHttp(server, deps.shutdownTimeoutMs - DRAIN_MARGIN_MS);
    if (hasFinished()) return;

    for (const hook of deps.hooks) {
      if (hasFinished()) return;
      await runHook(deps.logger, hook);
    }
    if (hasFinished()) return;
    clearTimeout(hard);
    finish(exitCode);
  }

  return { shutdown, installProcessHandlers };
}
