import type { Operation } from '../../crdt/index.js';
import { covers } from '../../crdt/index.js';
import type {
  DocumentRepository,
  DocumentSnapshot,
  DocumentStats,
  StoredDocument,
} from '../../domain/ports.js';

interface Row {
  createdAt: number;
  historyLength: number;
  snapshot: DocumentSnapshot | null;
  snapshots: number;
  log: Operation[];
}

/** Volatile adapter for tests and for running without a disk. Values are cloned to mimic serialisation. */
export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly docs = new Map<string, Row>();

  create(docId: string, createdAt: number): void {
    if (this.docs.has(docId)) throw new Error(`document ${docId} already exists`);
    this.docs.set(docId, { createdAt, historyLength: 0, snapshot: null, snapshots: 0, log: [] });
  }

  exists(docId: string): boolean {
    return this.docs.has(docId);
  }

  load(docId: string): StoredDocument | null {
    const row = this.docs.get(docId);
    if (!row) return null;
    return structuredClone({ snapshot: row.snapshot, log: row.log });
  }

  append(docId: string, ops: readonly Operation[]): void {
    const row = this.require(docId);
    row.log.push(...structuredClone(ops));
    row.historyLength += ops.length;
  }

  saveSnapshot(docId: string, snapshot: DocumentSnapshot): void {
    const row = this.require(docId);
    row.snapshot = structuredClone(snapshot);
    row.snapshots = 1;
    row.log = row.log.filter((op) => !covers(snapshot.base, op.id) || !covers(snapshot.crdt.vector, op.id));
  }

  stats(docId: string): DocumentStats | null {
    const row = this.docs.get(docId);
    if (!row) return null;
    return {
      createdAt: row.createdAt,
      historyLength: row.historyLength,
      retainedOps: row.log.length,
      snapshots: row.snapshots,
    };
  }

  close(): void {
    this.docs.clear();
  }

  private require(docId: string): Row {
    const row = this.docs.get(docId);
    if (!row) throw new Error(`document ${docId} does not exist`);
    return row;
  }
}
