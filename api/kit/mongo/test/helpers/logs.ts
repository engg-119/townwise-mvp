import { createLogger, type Logger } from '@ckeith26/server-core';

export function captureLogs(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ LOG_LEVEL: 'trace' }, {
    destination: {
      write(line: string): void {
        lines.push(line);
      },
    },
  });
  return { logger, lines };
}
