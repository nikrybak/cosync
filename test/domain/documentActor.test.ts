import { beforeEach, describe, expect, it } from 'vitest';
import { RgaText } from '../../src/crdt/index.js';
import { DocumentActor, type ActorSettings } from '../../src/domain/documentActor.js';
import { DocumentNotFoundError, ForbiddenOperationError, ProtocolError } from '../../src/domain/errors.js';
import { CloseCode } from '../../src/domain/messages.js';
import { InMemoryDocumentRepository } from '../../src/infrastructure/persistence/inMemoryDocumentRepository.js';
import { ManualClock, RecordingPeer, noopMetrics, silentLogger } from '../support/fakes.js';

const settings: ActorSettings = {
  presenceTimeoutMs: 5_000,
  heartbeatMs: 1_000,
  snapshotEveryOps: 1_000,
  replicaTtlMs: 60_000,
};

const user = { name: 'Ada', color: '#123456' };

describe('DocumentActor', () => {
  let repository: InMemoryDocumentRepository;
  let clock: ManualClock;
  const deps = () => ({ repository, clock, metrics: noopMetrics, logger: silentLogger, settings });

  beforeEach(() => {
    repository = new InMemoryDocumentRepository();
    clock = new ManualClock();
    repository.create('doc', clock.now());
  });

  it('refuses to load a document that was never created', () => {
    expect(() => DocumentActor.load('missing', deps())).toThrow(DocumentNotFoundError);
  });

  it('welcomes a client with a delta and relays its edits to others', async () => {
    const actor = DocumentActor.load('doc', deps());
    await actor.edit(0, 'hi');
    const a = new RecordingPeer();
    const b = new RecordingPeer();
    await actor.join('s1', a, { replicaId: 'ra', stateVector: {}, user });
    await actor.join('s2', b, { replicaId: 'rb', stateVector: {}, user });

    const welcome = a.ofType('welcome')[0]!;
    expect(welcome.sync.mode).toBe('delta');
    const clientA = new RgaText('ra');
    if (welcome.sync.mode === 'delta') clientA.apply(welcome.sync.ops);
    expect(clientA.text()).toBe('hi');
    expect(
      a
        .ofType('presence')
        .at(-1)
        ?.updated.map((p) => p.sessionId),
    ).toEqual(['s2']);

    await actor.submit('s1', clientA.insert(2, '!'));
    expect(b.ofType('ops').flatMap((m) => m.ops)).toHaveLength(1);
    expect(a.ofType('ops')).toHaveLength(0);
    expect((await actor.read()).text).toBe('hi!');
  });

  it('rejects operations authored for another replica', async () => {
    const actor = DocumentActor.load('doc', deps());
    await actor.join('s1', new RecordingPeer(), { replicaId: 'ra', stateVector: {}, user });
    const impostor = new RgaText('rb');
    await expect(actor.submit('s1', impostor.insert(0, 'x'))).rejects.toBeInstanceOf(ForbiddenOperationError);
    await expect(actor.submit('nobody', [])).rejects.toBeInstanceOf(ProtocolError);
  });

  it('sends only what a reconnecting client is missing', async () => {
    const actor = DocumentActor.load('doc', deps());
    const client = new RgaText('ra');
    await actor.join('s1', new RecordingPeer(), { replicaId: 'ra', stateVector: {}, user });
    await actor.submit('s1', client.insert(0, 'abc'));
    await actor.leave('s1');
    await actor.edit(3, 'de');

    const again = new RecordingPeer();
    await actor.join('s2', again, { replicaId: 'ra', stateVector: client.stateVector(), user });
    const sync = again.ofType('welcome')[0]!.sync;
    expect(sync.mode).toBe('delta');
    if (sync.mode === 'delta') {
      expect(sync.ops.map((op) => op.id.r)).toEqual(['~server', '~server']);
      client.apply(sync.ops);
    }
    expect(client.text()).toBe('abcde');
  });

  it('replaces an older session of the same replica', async () => {
    const actor = DocumentActor.load('doc', deps());
    const old = new RecordingPeer();
    await actor.join('s1', old, { replicaId: 'ra', stateVector: {}, user });
    await actor.join('s2', new RecordingPeer(), { replicaId: 'ra', stateVector: {}, user });
    expect(old.closed?.code).toBe(4409);
    expect(actor.sessionCount).toBe(1);
  });

  it('expires silent sessions and tells the others', async () => {
    const actor = DocumentActor.load('doc', deps());
    const quiet = new RecordingPeer();
    const chatty = new RecordingPeer();
    await actor.join('quiet', quiet, { replicaId: 'rq', stateVector: {}, user });
    await actor.join('chatty', chatty, { replicaId: 'rc', stateVector: {}, user });
    clock.advance(3_000);
    await actor.heartbeat('chatty', {});
    clock.advance(3_000);
    const report = await actor.tick();
    expect(report.expiredSessions).toEqual(['quiet']);
    expect(quiet.closed?.code).toBe(CloseCode.PresenceTimeout);
    expect(chatty.ofType('presence').at(-1)?.removed).toEqual(['quiet']);
  });

  it('garbage collects tombstones once every known replica acknowledged the delete', async () => {
    const actor = DocumentActor.load('doc', deps());
    const a = new RgaText('ra');
    const b = new RgaText('rb');
    const peerB = new RecordingPeer();
    await actor.join('sa', new RecordingPeer(), { replicaId: 'ra', stateVector: {}, user });
    await actor.join('sb', peerB, { replicaId: 'rb', stateVector: {}, user });
    await actor.submit('sa', a.insert(0, 'abc'));
    await actor.submit('sa', a.delete(2, 1));
    b.apply(peerB.ofType('ops').flatMap((m) => m.ops));

    expect((await actor.tick()).collectedTombstones).toBe(0);
    await actor.heartbeat('sa', a.stateVector());
    await actor.heartbeat('sb', b.stateVector());
    expect((await actor.tick()).collectedTombstones).toBe(1);
    expect(await actor.read()).toMatchObject({ text: 'ab', tombstones: 0, retainedOps: 0 });
  });

  it('serves a snapshot to a replica that is behind the trimmed log', async () => {
    const actor = DocumentActor.load('doc', deps());
    await actor.edit(0, 'stable');
    await actor.tick();
    const late = new RecordingPeer();
    await actor.join('late', late, { replicaId: 'rl', stateVector: {}, user });
    const sync = late.ofType('welcome')[0]!.sync;
    expect(sync.mode).toBe('snapshot');
    if (sync.mode === 'snapshot') expect(RgaText.fromSnapshot('rl', sync.snapshot).text()).toBe('stable');
  });

  it('recovers from snapshot plus the log written after it', async () => {
    const actor = DocumentActor.load('doc', deps());
    await actor.edit(0, 'one ');
    await actor.flush();
    await actor.edit(4, 'two');
    const restored = DocumentActor.load('doc', deps());
    expect((await restored.read()).text).toBe('one two');
  });

  it('flushes and disconnects everyone on close', async () => {
    const actor = DocumentActor.load('doc', deps());
    const peer = new RecordingPeer();
    await actor.join('s1', peer, { replicaId: 'ra', stateVector: {}, user });
    await actor.edit(0, 'bye');
    await actor.close();
    expect(peer.closed?.code).toBe(CloseCode.ServerShutdown);
    expect(repository.stats('doc')?.snapshots).toBe(1);
    await expect(actor.edit(0, 'x')).rejects.toThrow(/closed/);
  });
});
