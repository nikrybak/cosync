import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CloseCode } from '../../src/domain/messages.js';
import type { CosyncServer } from '../../src/server.js';
import { mulberry32 } from '../support/random.js';
import { createDocument, startServer, TestClient, waitFor } from '../support/testServer.js';

describe('collaboration over WebSockets', () => {
  let server: CosyncServer;
  let httpUrl: string;
  let wsUrl: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    ({ server, httpUrl, wsUrl } = await startServer());
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.disconnect()));
    await server.close();
  });

  const join = async (docId: string, name: string, heartbeats = true) => {
    const client = await new TestClient(wsUrl, docId, name).connect({ heartbeats });
    clients.push(client);
    return client;
  };

  const serverText = async (docId: string) => (await fetch(`${httpUrl}/api/docs/${docId}/text`)).text();

  it('three clients editing concurrently converge to the same text', async () => {
    const docId = await createDocument(httpUrl, 'shared: ');
    const [a, b, c] = await Promise.all([join(docId, 'Ann'), join(docId, 'Bob'), join(docId, 'Cid')]);
    const everyone = [a, b, c];
    await waitFor(() => everyone.every((x) => x.client.text === 'shared: '), 5_000, 'initial text');

    const rand = mulberry32(7);
    for (let round = 0; round < 30; round++) {
      for (const [i, x] of everyone.entries()) {
        const doc = x.client.doc;
        if (doc.length > 3 && rand() < 0.3) {
          x.client.delete(Math.floor(rand() * doc.length), 1);
        } else {
          x.client.insert(Math.floor(rand() * (doc.length + 1)), 'abc'[i]!);
        }
      }
    }

    await waitFor(
      () => everyone.every((x) => x.client.unacknowledged === 0 && x.client.text === a.client.text),
      10_000,
      'convergence',
    );
    expect(await serverText(docId)).toBe(a.client.text);
    expect(a.client.text.length).toBeGreaterThan(8);
  });

  it('reconnecting client receives only the missing operations and flushes its offline edits', async () => {
    const docId = await createDocument(httpUrl, 'base');
    const a = await join(docId, 'Ann');
    const b = await join(docId, 'Bob');
    await waitFor(() => a.client.text === 'base' && b.client.text === 'base');

    await a.disconnect();
    a.client.insert(4, ' from-a');
    b.client.insert(0, '[b]');
    await waitFor(() => b.client.unacknowledged === 0, 5_000, 'b ack');

    await a.connect();
    const welcome = a.lastWelcome()!;
    expect(welcome.sync.mode).toBe('delta');
    if (welcome.sync.mode === 'delta') expect(welcome.sync.ops).toHaveLength(3);

    await waitFor(() => b.client.text === a.client.text && a.client.unacknowledged === 0, 5_000, 'resync');
    expect(a.client.text).toBe('[b]base from-a');
    expect(await serverText(docId)).toBe('[b]base from-a');
  });

  it('shares cursors and drops a peer that stops sending heartbeats', async () => {
    const docId = await createDocument(httpUrl, 'hello');
    const quiet = await join(docId, 'Quiet', false);
    const watcher = await join(docId, 'Watcher');
    await waitFor(() => quiet.client.text === 'hello');

    quiet.client.setCursor(2, 4);
    await waitFor(() => watcher.client.peers.get(quiet.client.sessionId!)?.cursor !== null, 2_000, 'cursor');
    const cursor = watcher.client.peers.get(quiet.client.sessionId!)!.cursor!;
    expect(watcher.client.doc.resolveAnchor(cursor.anchor)).toBe(2);
    expect(watcher.client.doc.resolveAnchor(cursor.head)).toBe(4);

    await waitFor(() => quiet.closeCode === CloseCode.PresenceTimeout, 3_000, 'presence timeout');
    await waitFor(() => watcher.client.peers.size === 0, 2_000, 'peer removed');
    expect(watcher.closeCode).toBeNull();
  });

  it('validates messages and closes connections that break the protocol', async () => {
    const docId = await createDocument(httpUrl);
    const raw = async (payload: string | Buffer) => {
      const socket = new WebSocket(wsUrl);
      await new Promise((resolve) => socket.once('open', resolve));
      const messages: string[] = [];
      socket.on('message', (d: Buffer) => messages.push(d.toString()));
      const closed = new Promise<number>((resolve) => socket.once('close', resolve));
      socket.send(payload);
      return { code: await closed, messages };
    };

    const notJson = await raw('{nope');
    expect(notJson.code).toBe(CloseCode.ProtocolError);
    expect(notJson.messages[0]).toContain('bad_message');

    const future = await raw(JSON.stringify({ v: 99, type: 'hello' }));
    expect(future.messages[0]).toContain('unsupported_version');

    const early = await raw(JSON.stringify({ v: 1, type: 'heartbeat', stateVector: {} }));
    expect(early.messages[0]).toContain('not_joined');

    const unknown = await raw(
      JSON.stringify({
        v: 1,
        type: 'hello',
        docId: 'missing',
        replicaId: 'x',
        stateVector: {},
        user: { name: 'X', color: '#000000' },
      }),
    );
    expect(unknown.code).toBe(CloseCode.NotFound);

    const huge = await raw('x'.repeat(server.config.maxMessageBytes + 1));
    expect(huge.code).toBe(1009);

    const spoof = new TestClient(wsUrl, docId, 'Eve');
    await spoof.connect();
    clients.push(spoof);
    spoof.socket!.send(
      JSON.stringify({ v: 1, type: 'ops', ops: [{ type: 'insert', id: { r: 'other', c: 1 }, prev: 0, origin: null, value: 'x' }] }),
    );
    await waitFor(() => spoof.closeCode === CloseCode.ProtocolError, 2_000, 'spoof rejected');
    expect(server.metrics.counterValue('cosync_messages_rejected_total', { reason: 'forbidden_op' })).toBe(1);
  });

  it('exposes documents, health and metrics over HTTP', async () => {
    const docId = await createDocument(httpUrl, 'héllo 😀');
    const a = await join(docId, 'Ann');
    a.client.insert(0, '> ');
    await waitFor(() => a.client.unacknowledged === 0);

    const summary = (await (await fetch(`${httpUrl}/api/docs/${docId}`)).json()) as Record<string, unknown>;
    expect(summary).toMatchObject({ docId, text: '> héllo 😀', length: 9, activeSessions: 1 });
    const history = (await (await fetch(`${httpUrl}/api/docs/${docId}/history`)).json()) as Record<string, unknown>;
    expect(history).toEqual({ docId, historyLength: 9 });

    expect((await fetch(`${httpUrl}/api/docs/nope`)).status).toBe(404);
    expect((await fetch(`${httpUrl}/api/docs`, { method: 'POST', body: '{"text":1}', headers: { 'content-type': 'application/json' } })).status).toBe(400);

    const health = (await (await fetch(`${httpUrl}/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: 'ok', openDocuments: 1, connections: 1 });

    const metrics = await (await fetch(`${httpUrl}/metrics`)).text();
    expect(metrics).toContain('# TYPE cosync_ops_applied_total counter');
    expect(metrics).toMatch(/cosync_ops_applied_total 9/);
    expect(metrics).toMatch(/cosync_connections 1/);
  });
});
