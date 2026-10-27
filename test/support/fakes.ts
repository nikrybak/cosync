import type { ServerMessage } from '../../src/domain/messages.js';
import type { Clock, Logger, Metrics, Peer } from '../../src/domain/ports.js';

export class ManualClock implements Clock {
  constructor(private time = 1_000) {}
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

export class RecordingPeer implements Peer {
  readonly messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  send(message: ServerMessage): void {
    this.messages.push(structuredClone(message));
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

export const noopMetrics: Metrics = {
  increment: () => undefined,
  gauge: () => undefined,
};
