import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RgaText } from '../../src/crdt/index.js';
import { SqliteDocumentRepository } from '../../src/infrastructure/persistence/sqliteDocumentRepository.js';
import { createDocument, startServer, TestClient, testConfig, waitFor } from '../support/testServer.js';

describe('SqliteDocumentRepository', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cosync-repo-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends, snapshots and compacts the op log', () => {
    const repo = new SqliteDocumentRepository(join(dir, 'a.db'));
    repo.create('d', 1);
    const doc = new RgaText('r');
    repo.append('d', doc.insert(0, 'abc'));
    expect(repo.load('d')?.log).toHaveLength(3);

    const crdt = doc.snapshot();
    repo.saveSnapshot('d', { crdt, replicas: {}, base: { r: 2 } });
    repo.append('d', doc.insert(3, 'd'));
    // Only the op not covered by base survives compaction, plus the newer one.
    const stored = repo.load('d')!;
    expect(stored.log.map((op) => op.id.c)).toEqual([3, 4]);
    expect(stored.snapshot?.crdt.elements).toHaveLength(3);
    expect(repo.stats('d')).toMatchObject({ historyLength: 4, retainedOps: 2, snapshots: 1 });
    repo.close();

    const reopened = new SqliteDocumentRepository(join(dir, 'a.db'));
    expect(reopened.exists('d')).toBe(true);
    expect(reopened.load('missing')).toBeNull();
    reopened.close();
  });

  it('keeps sequence numbers monotonic after the log was fully compacted', () => {
    const repo = new SqliteDocumentRepository(':memory:');
    repo.create('d', 1);
    const doc = new RgaText('r');
    repo.append('d', doc.insert(0, 'ab'));
    repo.saveSnapshot('d', { crdt: doc.snapshot(), replicas: {}, base: doc.stateVector() });
    expect(repo.load('d')?.log).toHaveLength(0);
    repo.append('d', doc.insert(2, 'c'));
    repo.saveSnapshot('d', { crdt: doc.snapshot(), replicas: {}, base: {} });
    expect(repo.load('d')?.log.map((op) => op.id.c)).toEqual([3]);
    repo.close();
  });
});

describe('recovery after restart', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cosync-recovery-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores a document from its snapshot plus the log tail after a crash', async () => {
    const dbPath = join(dir, 'cosync.db');
    const config = testConfig({ dbPath, snapshotEveryOps: 5 });
    const first = await startServer(config);
    const docId = await createDocument(first.httpUrl);
    const writer = await new TestClient(first.wsUrl, docId, 'Ann').connect();
    for (const ch of 'hello, world') writer.client.insert(writer.client.doc.length, ch);
    await waitFor(() => writer.client.unacknowledged === 0, 5_000, 'acks');

    // Snapshots were taken every 5 ops; the last two ops exist only in the log.
    const probe = new SqliteDocumentRepository(dbPath);
    const stats = probe.stats(docId)!;
    expect(stats.snapshots).toBe(1);
    expect(stats.historyLength).toBe(12);
    const stored = probe.load(docId)!;
    expect(RgaText.fromSnapshot('probe', stored.snapshot!.crdt).text()).toBe('hello, wor');
    probe.close();

    // A second process on the same file, without the first one flushing: a crash as far as it can tell.
    const second = await startServer(testConfig({ dbPath }));
    const reader = await new TestClient(second.wsUrl, docId, 'Bob').connect();
    expect(reader.client.text).toBe('hello, world');
    await reader.disconnect();
    await second.server.close();

    await writer.disconnect();
    await first.server.close();
  });

  it('flushes snapshots on graceful shutdown and resumes delta sync afterwards', async () => {
    const dbPath = join(dir, 'cosync.db');
    const first = await startServer(testConfig({ dbPath, snapshotEveryOps: 10_000 }));
    const docId = await createDocument(first.httpUrl, 'persist me');
    const ann = await new TestClient(first.wsUrl, docId, 'Ann').connect();
    await waitFor(() => ann.client.text === 'persist me');
    ann.client.insert(0, '* ');
    await waitFor(() => ann.client.unacknowledged === 0);
    await first.server.close();
    await waitFor(() => ann.closeCode !== null, 2_000, 'shutdown close');

    const probe = new SqliteDocumentRepository(dbPath);
    expect(probe.stats(docId)?.snapshots).toBe(1);
    probe.close();

    const second = await startServer(testConfig({ dbPath }));
    // Same replica, same local state: reconnects into a delta with nothing missing.
    const ann2 = await new TestClient(second.wsUrl, docId, 'Ann', 'ann', ann.client).connect();
    expect(ann2.lastWelcome()?.sync.mode).toBe('delta');
    expect(ann.client.text).toBe('* persist me');
    await ann2.disconnect();
    await second.server.close();
  });
});
