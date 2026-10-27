import {
  covers,
  dominates,
  mergeVectors,
  minVectors,
  RgaText,
  type Operation,
  type StateVector,
} from '../crdt/index.js';
import { DocumentClosedError, DocumentNotFoundError, ForbiddenOperationError, ProtocolError } from './errors.js';
import { Mailbox } from './mailbox.js';
import { CloseCode, PROTOCOL_VERSION, type Cursor, type SyncPayload, type UserInfo } from './messages.js';
import type { Clock, DocumentRepository, DocumentSnapshot, Logger, Metrics, Peer, ReplicaRecord } from './ports.js';
import { PresenceTracker } from './presence.js';

/** Replica id the server uses for edits it authors itself, such as the initial text of a document. */
export const SERVER_REPLICA = '~server';

export interface ActorSettings {
  readonly presenceTimeoutMs: number;
  readonly heartbeatMs: number;
  readonly snapshotEveryOps: number;
  readonly replicaTtlMs: number;
}

export interface ActorDependencies {
  readonly repository: DocumentRepository;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly settings: ActorSettings;
}

export interface JoinRequest {
  readonly replicaId: string;
  readonly stateVector: StateVector;
  readonly user: UserInfo;
}

export interface DocumentView {
  readonly docId: string;
  readonly text: string;
  readonly length: number;
  readonly stateVector: StateVector;
  readonly tombstones: number;
  readonly retainedOps: number;
  readonly sessions: number;
}

export interface TickReport {
  readonly expiredSessions: readonly string[];
  readonly collectedTombstones: number;
}

interface Session {
  readonly id: string;
  readonly replicaId: string;
  readonly peer: Peer;
}

/**
 * Owns one open document. Every mutation goes through the mailbox, so the CRDT, the
 * session table and the retained log are only ever touched by one task at a time.
 *
 * The retained log holds every operation not yet known to all replicas (`base` marks
 * the trimmed prefix). A replica whose state vector dominates `base` can be served a
 * delta from it; anyone further behind gets a full snapshot.
 */
export class DocumentActor {
  private readonly mailbox = new Mailbox();
  private readonly sessions = new Map<string, Session>();
  private readonly presence = new PresenceTracker();
  private readonly replicas: Map<string, ReplicaRecord>;
  private retained: Operation[];
  private base: StateVector;
  private opsSinceSnapshot = 0;
  private dirty = false;
  private closed = false;
  private readonly log: Logger;

  private constructor(
    readonly docId: string,
    private readonly crdt: RgaText,
    snapshot: DocumentSnapshot | null,
    log: readonly Operation[],
    private readonly deps: ActorDependencies,
  ) {
    this.base = snapshot?.base ?? {};
    this.replicas = new Map(Object.entries(snapshot?.replicas ?? {}));
    this.retained = log.filter((op) => !covers(this.base, op.id));
    this.log = deps.logger.child({ docId });
  }

  /** Rebuilds the document from its latest snapshot plus the log written after it. */
  static load(docId: string, deps: ActorDependencies): DocumentActor {
    const stored = deps.repository.load(docId);
    if (!stored) throw new DocumentNotFoundError(docId);
    const crdt = stored.snapshot
      ? RgaText.fromSnapshot(SERVER_REPLICA, stored.snapshot.crdt)
      : new RgaText(SERVER_REPLICA);
    // Entries already folded into the snapshot are reported as duplicates and skipped.
    crdt.apply(stored.log);
    return new DocumentActor(docId, crdt, stored.snapshot, stored.log, deps);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  get queueDepth(): number {
    return this.mailbox.size;
  }

  join(sessionId: string, peer: Peer, request: JoinRequest): Promise<void> {
    return this.mailbox.post(() => {
      this.assertOpen();
      const now = this.deps.clock.now();
      for (const other of this.sessions.values()) {
        if (other.replicaId === request.replicaId) {
          // A reconnect often arrives before the old socket is noticed as dead.
          this.dropSession(other.id);
          other.peer.close(4409, 'replaced by a newer session');
        }
      }
      this.sessions.set(sessionId, { id: sessionId, replicaId: request.replicaId, peer });
      this.noteSeen(request.replicaId, request.stateVector, now);

      const sync: SyncPayload = dominates(request.stateVector, this.base)
        ? { mode: 'delta', ops: this.retained.filter((op) => !covers(request.stateVector, op.id)) }
        : { mode: 'snapshot', snapshot: this.crdt.snapshot() };
      const state = this.presence.join(sessionId, request.replicaId, request.user, now);
      peer.send({
        v: PROTOCOL_VERSION,
        type: 'welcome',
        sessionId,
        docId: this.docId,
        stateVector: this.crdt.stateVector(),
        sync,
        peers: this.presence.list(sessionId),
        heartbeatMs: this.deps.settings.heartbeatMs,
      });
      this.broadcastPresence([state], [], sessionId);
      this.log.info({ sessionId, replicaId: request.replicaId, sync: sync.mode }, 'session joined');
    });
  }

  leave(sessionId: string): Promise<void> {
    return this.mailbox.post(() => {
      if (this.dropSession(sessionId)) this.log.info({ sessionId }, 'session left');
    });
  }

  submit(sessionId: string, ops: readonly Operation[]): Promise<void> {
    return this.mailbox.post(() => {
      this.assertOpen();
      const session = this.requireSession(sessionId);
      const foreign = ops.find((op) => op.id.r !== session.replicaId);
      if (foreign) {
        throw new ForbiddenOperationError(`session ${sessionId} may only author ops for replica ${session.replicaId}`);
      }
      const report = this.crdt.apply(ops);
      if (report.duplicates > 0) this.deps.metrics.increment('cosync_ops_duplicate_total', report.duplicates);
      const lastOwn = ops.at(-1);
      if (lastOwn && report.pending === 0) {
        this.noteSeen(session.replicaId, { [session.replicaId]: lastOwn.id.c }, this.deps.clock.now());
      }
      this.commit(report.applied);
      const upTo = this.crdt.stateVector()[session.replicaId];
      if (upTo !== undefined) session.peer.send({ v: PROTOCOL_VERSION, type: 'ack', upTo });
    });
  }

  heartbeat(sessionId: string, stateVector: StateVector): Promise<void> {
    return this.mailbox.post(() => {
      const session = this.requireSession(sessionId);
      const now = this.deps.clock.now();
      this.presence.touch(sessionId, now);
      this.noteSeen(session.replicaId, stateVector, now);
    });
  }

  awareness(sessionId: string, cursor: Cursor | null): Promise<void> {
    return this.mailbox.post(() => {
      this.requireSession(sessionId);
      const state = this.presence.updateCursor(sessionId, cursor, this.deps.clock.now());
      if (state) this.broadcastPresence([state], [], sessionId);
    });
  }

  /** Inserts text authored by the server itself. */
  edit(index: number, text: string): Promise<void> {
    return this.mailbox.post(() => {
      this.assertOpen();
      this.commit(this.crdt.insert(index, text));
    });
  }

  read(): Promise<DocumentView> {
    return this.mailbox.post(() => ({
      docId: this.docId,
      text: this.crdt.text(),
      length: this.crdt.length,
      stateVector: this.crdt.stateVector(),
      tombstones: this.crdt.tombstones,
      retainedOps: this.retained.length,
      sessions: this.sessions.size,
    }));
  }

  /** Periodic housekeeping: presence timeouts, replica eviction, garbage collection. */
  tick(): Promise<TickReport> {
    return this.mailbox.post(() => {
      const now = this.deps.clock.now();
      const expired = this.presence.expire(now, this.deps.settings.presenceTimeoutMs);
      for (const sessionId of expired) {
        const session = this.sessions.get(sessionId);
        this.dropSession(sessionId);
        session?.peer.close(CloseCode.PresenceTimeout, 'presence timeout');
        this.deps.metrics.increment('cosync_presence_timeouts_total');
      }
      const active = new Set([...this.sessions.values()].map((s) => s.replicaId));
      for (const [replicaId, record] of this.replicas) {
        // A replica gone this long is forgotten so it stops pinning tombstones; if it comes
        // back it will be behind `base` and receive a snapshot instead of a delta.
        if (!active.has(replicaId) && now - record.lastSeen > this.deps.settings.replicaTtlMs) {
          this.replicas.delete(replicaId);
        }
      }
      return { expiredSessions: expired, collectedTombstones: this.compact() };
    });
  }

  flush(): Promise<void> {
    return this.mailbox.post(() => {
      if (this.dirty) this.snapshot();
    });
  }

  /** Flushes a final snapshot and disconnects everyone. Further calls are rejected. */
  close(reason = 'document closed'): Promise<void> {
    return this.mailbox.post(() => {
      if (this.closed) return;
      if (this.dirty) this.snapshot();
      for (const session of this.sessions.values()) session.peer.close(CloseCode.ServerShutdown, reason);
      this.sessions.clear();
      this.closed = true;
    });
  }

  private commit(applied: readonly Operation[]): void {
    if (applied.length === 0) return;
    // Durable before visible: nobody hears about an op the log could still lose.
    this.deps.repository.append(this.docId, applied);
    this.retained.push(...applied);
    this.dirty = true;
    this.opsSinceSnapshot += applied.length;
    this.deps.metrics.increment('cosync_ops_applied_total', applied.length);
    for (const session of this.sessions.values()) {
      const relevant = applied.filter((op) => op.id.r !== session.replicaId);
      if (relevant.length > 0) session.peer.send({ v: PROTOCOL_VERSION, type: 'ops', ops: relevant });
    }
    if (this.opsSinceSnapshot >= this.deps.settings.snapshotEveryOps) this.snapshot();
  }

  private compact(): number {
    const stable = minVectors([this.crdt.stateVector(), ...[...this.replicas.values()].map((r) => r.vector)]);
    const collected = this.crdt.collectGarbage(stable);
    const before = this.retained.length;
    this.retained = this.retained.filter((op) => !covers(stable, op.id));
    this.base = mergeVectors(this.base, stable);
    if (collected > 0 || before !== this.retained.length) this.dirty = true;
    if (collected > 0) this.deps.metrics.increment('cosync_tombstones_collected_total', collected);
    return collected;
  }

  private snapshot(): void {
    this.compact();
    this.deps.repository.saveSnapshot(this.docId, {
      crdt: this.crdt.snapshot(),
      replicas: Object.fromEntries(this.replicas),
      base: this.base,
    });
    this.opsSinceSnapshot = 0;
    this.dirty = false;
    this.deps.metrics.increment('cosync_snapshots_total');
    this.log.debug({ retained: this.retained.length, tombstones: this.crdt.tombstones }, 'snapshot written');
  }

  private noteSeen(replicaId: string, vector: StateVector, now: number): void {
    const previous = this.replicas.get(replicaId);
    this.replicas.set(replicaId, {
      vector: previous ? mergeVectors(previous.vector, vector) : { ...vector },
      lastSeen: now,
    });
  }

  private dropSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    this.presence.leave(sessionId);
    const record = this.replicas.get(session.replicaId);
    if (record) this.replicas.set(session.replicaId, { ...record, lastSeen: this.deps.clock.now() });
    this.broadcastPresence([], [sessionId]);
    return true;
  }

  private broadcastPresence(updated: ReturnType<PresenceTracker['list']>, removed: string[], except?: string): void {
    for (const session of this.sessions.values()) {
      if (session.id === except) continue;
      // Departures are never dropped: a missed one would leave a ghost cursor behind.
      session.peer.send({ v: PROTOCOL_VERSION, type: 'presence', updated, removed }, { droppable: removed.length === 0 });
    }
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProtocolError('not_joined', `session ${sessionId} is not part of ${this.docId}`);
    return session;
  }

  private assertOpen(): void {
    if (this.closed) throw new DocumentClosedError(this.docId);
  }
}
