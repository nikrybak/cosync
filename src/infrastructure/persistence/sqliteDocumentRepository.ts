import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Operation } from '../../crdt/index.js';
import type { DocumentRepository, DocumentSnapshot, DocumentStats, StoredDocument } from '../../domain/ports.js';

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE documents (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     history_length INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE ops (
     doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     replica TEXT NOT NULL,
     clock INTEGER NOT NULL,
     body TEXT NOT NULL,
     PRIMARY KEY (doc_id, seq)
   ) WITHOUT ROWID;
   CREATE TABLE snapshots (
     doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     upto_seq INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     body TEXT NOT NULL,
     PRIMARY KEY (doc_id, upto_seq)
   ) WITHOUT ROWID;`,
];

interface SnapshotRow {
  upto_seq: number;
  body: string;
}

/**
 * Append-only op log plus periodic snapshots. Writes are synchronous and run inside
 * transactions; WAL mode lets the HTTP API read while an actor appends.
 */
export class SqliteDocumentRepository implements DocumentRepository {
  private readonly db: Database.Database;
  private readonly statements;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.statements = {
      create: this.db.prepare<[string, number]>('INSERT INTO documents (id, created_at) VALUES (?, ?)'),
      exists: this.db.prepare<[string], { one: number }>('SELECT 1 AS one FROM documents WHERE id = ?'),
      lastSeq: this.db.prepare<[string, string], { seq: number | null }>(
        `SELECT MAX(seq) AS seq FROM (
           SELECT MAX(seq) AS seq FROM ops WHERE doc_id = ?
           UNION ALL SELECT MAX(upto_seq) FROM snapshots WHERE doc_id = ?)`,
      ),
      insertOp: this.db.prepare<[string, number, string, number, string]>(
        'INSERT INTO ops (doc_id, seq, replica, clock, body) VALUES (?, ?, ?, ?, ?)',
      ),
      bumpHistory: this.db.prepare<[number, string]>(
        'UPDATE documents SET history_length = history_length + ? WHERE id = ?',
      ),
      latestSnapshot: this.db.prepare<[string], SnapshotRow>(
        'SELECT upto_seq, body FROM snapshots WHERE doc_id = ? ORDER BY upto_seq DESC LIMIT 1',
      ),
      log: this.db.prepare<[string], { body: string }>('SELECT body FROM ops WHERE doc_id = ? ORDER BY seq'),
      insertSnapshot: this.db.prepare<[string, number, number, string]>(
        'INSERT OR REPLACE INTO snapshots (doc_id, upto_seq, created_at, body) VALUES (?, ?, ?, ?)',
      ),
      dropOldSnapshots: this.db.prepare<[string, number]>('DELETE FROM snapshots WHERE doc_id = ? AND upto_seq < ?'),
      compact: this.db.prepare<[string, number, string, number]>(
        'DELETE FROM ops WHERE doc_id = ? AND seq <= ? AND replica = ? AND clock <= ?',
      ),
      stats: this.db.prepare<
        [string],
        { created_at: number; history_length: number; retained: number; snapshots: number }
      >(
        `SELECT d.created_at, d.history_length,
                (SELECT COUNT(*) FROM ops o WHERE o.doc_id = d.id) AS retained,
                (SELECT COUNT(*) FROM snapshots s WHERE s.doc_id = d.id) AS snapshots
         FROM documents d WHERE d.id = ?`,
      ),
    };
  }

  create(docId: string, createdAt: number): void {
    this.statements.create.run(docId, createdAt);
  }

  exists(docId: string): boolean {
    return this.statements.exists.get(docId) !== undefined;
  }

  load(docId: string): StoredDocument | null {
    if (!this.exists(docId)) return null;
    const row = this.statements.latestSnapshot.get(docId);
    return {
      snapshot: row ? (JSON.parse(row.body) as DocumentSnapshot) : null,
      log: this.statements.log.all(docId).map((r) => JSON.parse(r.body) as Operation),
    };
  }

  append(docId: string, ops: readonly Operation[]): void {
    this.db.transaction(() => {
      let seq = this.lastSeq(docId);
      for (const op of ops) this.statements.insertOp.run(docId, ++seq, op.id.r, op.id.c, JSON.stringify(op));
      this.statements.bumpHistory.run(ops.length, docId);
    })();
  }

  saveSnapshot(docId: string, snapshot: DocumentSnapshot): void {
    this.db.transaction(() => {
      const upto = this.lastSeq(docId);
      this.statements.insertSnapshot.run(docId, upto, Date.now(), JSON.stringify(snapshot));
      this.statements.dropOldSnapshots.run(docId, upto);
      // Rows folded into this snapshot and known to every replica are no longer needed for delta sync.
      for (const [replica, clock] of Object.entries(snapshot.base)) {
        this.statements.compact.run(docId, upto, replica, clock);
      }
    })();
  }

  stats(docId: string): DocumentStats | null {
    const row = this.statements.stats.get(docId);
    if (!row) return null;
    return {
      createdAt: row.created_at,
      historyLength: row.history_length,
      retainedOps: row.retained,
      snapshots: row.snapshots,
    };
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private lastSeq(docId: string): number {
    return this.statements.lastSeq.get(docId, docId)?.seq ?? 0;
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v];
      if (sql === undefined) break;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }
}
