import { WebSocket } from 'ws';
import { CollabClient } from '../../client/collabClient.js';
import { loadConfig, type Config } from '../../src/config/config.js';
import type { ServerMessage } from '../../src/domain/messages.js';
import type { DocumentRepository } from '../../src/domain/ports.js';
import { CosyncServer } from '../../src/server.js';
import { silentLogger } from './fakes.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ HOST: '127.0.0.1', PORT: '0', DB_PATH: ':memory:', LOG_LEVEL: 'silent', TICK_MS: '50' }),
    heartbeatMs: 100,
    presenceTimeoutMs: 600,
    idleUnloadMs: 60_000,
    shutdownGraceMs: 1_000,
    ...overrides,
  };
}

export async function startServer(
  config: Config = testConfig(),
  repository?: DocumentRepository,
): Promise<{ server: CosyncServer; httpUrl: string; wsUrl: string }> {
  const server = await CosyncServer.create(config, {
    logger: silentLogger,
    publicDir: null,
    ...(repository ? { repository } : {}),
  });
  await server.listen();
  return { server, httpUrl: `http://127.0.0.1:${server.port}`, wsUrl: `ws://127.0.0.1:${server.port}/ws` };
}

export async function createDocument(httpUrl: string, text?: string): Promise<string> {
  const res = await fetch(`${httpUrl}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(text === undefined ? {} : { text }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return ((await res.json()) as { docId: string }).docId;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A real WebSocket connection driving a CollabClient, with recording for assertions. */
export class TestClient {
  readonly client: CollabClient;
  readonly received: ServerMessage[] = [];
  socket: WebSocket | null = null;
  closeCode: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly wsUrl: string,
    docId: string,
    name: string,
    replicaId = name.toLowerCase(),
    existing?: CollabClient,
  ) {
    this.client = existing ?? new CollabClient(docId, replicaId, { name, color: '#336699' });
  }

  async connect(options: { heartbeats?: boolean } = {}): Promise<this> {
    const socket = new WebSocket(this.wsUrl);
    this.socket = socket;
    this.closeCode = null;
    const before = this.received.length;
    socket.on('message', (data: Buffer) => {
      this.received.push(this.client.receive(data.toString('utf8')));
    });
    socket.on('close', (code) => {
      this.closeCode = code;
      this.stopHeartbeats();
      if (this.socket === socket) this.client.detach();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    this.client.attach({
      send: (data) => {
        socket.send(data);
      },
    });
    await waitFor(
      () => this.received.slice(before).some((m) => m.type === 'welcome' || m.type === 'error'),
      5_000,
      'welcome',
    );
    if (options.heartbeats ?? true) this.startHeartbeats();
    return this;
  }

  startHeartbeats(): void {
    this.stopHeartbeats();
    this.heartbeatTimer = setInterval(() => {
      this.client.heartbeat();
    }, this.client.heartbeatMs);
  }

  stopHeartbeats(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  lastWelcome(): Extract<ServerMessage, { type: 'welcome' }> | undefined {
    return this.received.filter((m): m is Extract<ServerMessage, { type: 'welcome' }> => m.type === 'welcome').at(-1);
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeats();
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
      socket.close();
    });
  }
}
