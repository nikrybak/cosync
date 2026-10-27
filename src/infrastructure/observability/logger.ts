import { pino } from 'pino';
import type { Logger } from '../../domain/ports.js';

export interface LoggerOptions {
  readonly level: string;
  readonly pretty: boolean;
}

export function createLogger(options: LoggerOptions): Logger & { flush(): void } {
  return pino({
    level: options.level,
    base: { service: 'cosync' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(options.pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}
