import type { Operation, RgaSnapshot, StateVector } from '../crdt/index.js';
import type { ServerMessage } from './messages.js';

export interface Clock {
  now(): number;
}

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type CounterName =
  | 'cosync_ops_applied_total'
  | 'cosync_ops_duplicate_total'
  | 'cosync_messages_rejected_total'
  | 'cosync_backpressure_disconnects_total'
  | 'cosync_presence_dropped_total'
  | 'cosync_snapshots_total'
  | 'cosync_tombstones_collected_total'
  | 'cosync_documents_loaded_total'
  | 'cosync_documents_unloaded_total'
  | 'cosync_presence_timeouts_total';

export type GaugeName = 'cosync_connections' | 'cosync_documents_open' | 'cosync_sessions';

export interface Metrics {
  increment(name: CounterName, value?: number, labels?: Readonly<Record<string, string>>): void;
  gauge(name: GaugeName, value: number): void;
}

/** What a connected client looks like to the domain: a mailbox it can post to. */
export interface Peer {
  /** `droppable` messages (presence) may be skipped under backpressure; the rest may not. */
  send(message: ServerMessage, options?: { readonly droppable?: boolean }): void;
  close(code: number, reason: string): void;
}

export interface ReplicaRecord {
  readonly vector: StateVector;
  readonly lastSeen: number;
}

/** Everything needed to rebuild a document actor without replaying the full history. */
export interface DocumentSnapshot {
  readonly crdt: RgaSnapshot;
  readonly replicas: Readonly<Record<string, ReplicaRecord>>;
  /** Every operation not covered by this vector is still in the op log. */
  readonly base: StateVector;
}

export interface StoredDocument {
  readonly snapshot: DocumentSnapshot | null;
  /** Retained log entries in append order, which is a causal order. */
  readonly log: readonly Operation[];
}

export interface DocumentStats {
  readonly createdAt: number;
  readonly historyLength: number;
  readonly retainedOps: number;
  readonly snapshots: number;
}

/**
 * Persistence port. Synchronous on purpose: the SQLite adapter is synchronous and a
 * write completes before the actor acknowledges anything, which keeps durability simple.
 */
export interface DocumentRepository {
  create(docId: string, createdAt: number): void;
  exists(docId: string): boolean;
  load(docId: string): StoredDocument | null;
  append(docId: string, ops: readonly Operation[]): void;
  /** Stores the snapshot and drops log entries that are both covered by it and by `snapshot.base`. */
  saveSnapshot(docId: string, snapshot: DocumentSnapshot): void;
  stats(docId: string): DocumentStats | null;
  close(): void;
}
