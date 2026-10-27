import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { ClientSession, CollaborationService } from '../../application/collaborationService.js';
import { CrdtError } from '../../crdt/index.js';
import { DomainError } from '../../domain/errors.js';
import { CloseCode, PROTOCOL_VERSION, type ErrorCode, type ServerMessage } from '../../domain/messages.js';
import type { Logger, Metrics, Peer } from '../../domain/ports.js';
import { ClientMessageParser } from './protocolSchema.js';

export interface WsTransportOptions {
  readonly path: string;
  readonly maxMessageBytes: number;
  readonly maxOpsPerMessage: number;
  /** Above this many queued bytes a connection is dropped; the client resyncs with a delta on reconnect. */
  readonly backpressureHighWaterBytes: number;
  /** Above this many queued bytes presence updates are skipped; they are superseded by the next one anyway. */
  readonly presenceDropWaterBytes: number;
  /** Interval of protocol-level pings used to find dead TCP connections. */
  readonly pingIntervalMs: number;
}

interface Connection {
  readonly socket: WebSocket;
  alive: boolean;
}

/**
 * Adapts `ws` sockets to the application. Messages of one connection are processed
 * strictly one after another, which preserves the per-replica FIFO order the CRDT relies on.
 */
export class WsTransport {
  private readonly wss: WebSocketServer;
  private readonly parser: ClientMessageParser;
  private readonly connections = new Set<Connection>();
  private pinger: NodeJS.Timeout | null = null;
  private accepting = true;

  constructor(
    private readonly service: CollaborationService,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly options: WsTransportOptions,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: options.maxMessageBytes });
    this.parser = new ClientMessageParser(options.maxOpsPerMessage);
  }

  attach(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path !== this.options.path || !this.accepting) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.onConnection(ws);
      });
    });
    this.pinger = setInterval(() => {
      for (const connection of this.connections) {
        if (!connection.alive) {
          connection.socket.terminate();
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
      }
    }, this.options.pingIntervalMs);
    this.pinger.unref();
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Stops accepting connections and closes the remaining ones, terminating stragglers after `graceMs`. */
  async close(graceMs: number): Promise<void> {
    this.accepting = false;
    if (this.pinger) clearInterval(this.pinger);
    const closing = [...this.connections].map(
      ({ socket }) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            socket.terminate();
          }, graceMs);
          socket.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          socket.close(CloseCode.ServerShutdown, 'server shutting down');
        }),
    );
    await Promise.all(closing);
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
  }

  private onConnection(socket: WebSocket): void {
    const connection: Connection = { socket, alive: true };
    this.connections.add(connection);
    this.metrics.gauge('cosync_connections', this.connections.size);
    const session = this.service.connect(this.peerFor(socket));
    const log = this.logger.child({ sessionId: session.sessionId });
    let queue: Promise<void> = Promise.resolve();

    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (data: RawData, isBinary: boolean) => {
      queue = queue.then(() => this.dispatch(session, socket, data, isBinary, log));
    });
    socket.on('error', (err) => {
      // ws closes the socket itself after an error such as an oversized frame (1009).
      log.warn({ err: err.message }, 'socket error');
      this.metrics.increment('cosync_messages_rejected_total', 1, { reason: 'socket_error' });
    });
    socket.on('close', (code: number) => {
      this.connections.delete(connection);
      this.metrics.gauge('cosync_connections', this.connections.size);
      log.debug({ code }, 'socket closed');
      queue = queue.then(() => session.disconnect());
    });
  }

  private peerFor(socket: WebSocket): Peer {
    return {
      send: (message: ServerMessage, options) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (options?.droppable && socket.bufferedAmount > this.options.presenceDropWaterBytes) {
          this.metrics.increment('cosync_presence_dropped_total');
          return;
        }
        if (socket.bufferedAmount > this.options.backpressureHighWaterBytes) {
          // Buffering without bound would let one slow reader exhaust server memory. Dropping it
          // is lossless: it reconnects with its state vector and receives only what it missed.
          this.metrics.increment('cosync_backpressure_disconnects_total');
          socket.terminate();
          return;
        }
        socket.send(JSON.stringify(message));
      },
      close: (code: number, reason: string) => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(code, reason);
        }
      },
    };
  }

  private async dispatch(
    session: ClientSession,
    socket: WebSocket,
    data: RawData,
    isBinary: boolean,
    log: Logger,
  ): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (isBinary) {
      this.reject(socket, 'bad_message', 'binary frames are not supported');
      return;
    }
    const parsed = this.parser.parse(rawToString(data));
    if (!parsed.ok) {
      this.reject(socket, parsed.code, parsed.detail);
      return;
    }
    try {
      await session.handle(parsed.message);
    } catch (err: unknown) {
      if (err instanceof DomainError) {
        this.reject(socket, err.code, err.message, err.code === 'doc_not_found' ? CloseCode.NotFound : undefined);
      } else if (err instanceof CrdtError) {
        this.reject(socket, 'integrity', err.message);
      } else {
        log.error({ err }, 'unexpected failure while handling a message');
        this.reject(socket, 'internal', 'internal error', 1011);
      }
    }
  }

  private reject(
    socket: WebSocket,
    code: ErrorCode,
    message: string,
    closeCode: number = CloseCode.ProtocolError,
  ): void {
    this.metrics.increment('cosync_messages_rejected_total', 1, { reason: code });
    if (socket.readyState !== WebSocket.OPEN) return;
    const error: ServerMessage = { v: PROTOCOL_VERSION, type: 'error', code, message };
    socket.send(JSON.stringify(error));
    socket.close(closeCode, code);
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
