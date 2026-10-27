import { CrdtError } from './errors.js';
import { compareIds, idKey, type OpId, type ReplicaId } from './ids.js';
import type { DeleteOp, InsertOp, Operation } from './operations.js';
import { covers, type StateVector } from './stateVector.js';

interface Element {
  readonly id: OpId;
  readonly origin: OpId | null;
  readonly value: string;
  deletedBy: OpId | null;
}

export interface SnapshotElement {
  readonly id: OpId;
  readonly origin: OpId | null;
  readonly value: string;
  readonly deletedBy: OpId | null;
}

export interface RgaSnapshot {
  readonly version: 1;
  readonly clock: number;
  readonly vector: StateVector;
  readonly elements: readonly SnapshotElement[];
  readonly pending: readonly Operation[];
}

export interface ApplyReport {
  readonly applied: readonly Operation[];
  readonly duplicates: number;
  readonly pending: number;
}

type Readiness = 'ready' | 'duplicate' | 'blocked';

/**
 * Replicated Growable Array over Unicode code points.
 *
 * Elements live in one array in document order, deleted ones included (tombstones),
 * because concurrent inserts may still be anchored on them. An insert is placed right
 * after its origin, skipping every element with a greater id: with Lamport clocks,
 * anything that sorts after the new id is either a concurrent sibling that wins the tie
 * or a descendant of such a sibling, so every replica arrives at the same order.
 */
export class RgaText {
  private elements: Element[] = [];
  private readonly byKey = new Map<string, Element>();
  /** How many elements use a given element as their origin; a tombstone with dependants cannot be collected. */
  private readonly dependants = new Map<string, number>();
  private vector: Record<ReplicaId, number> = {};
  private clock = 0;
  private pending: Operation[] = [];
  private readonly pendingKeys = new Set<string>();
  private visible = 0;

  constructor(readonly replicaId: ReplicaId) {
    if (replicaId.length === 0) throw new CrdtError('integrity', 'replica id must not be empty');
  }

  static fromSnapshot(replicaId: ReplicaId, snapshot: RgaSnapshot): RgaText {
    if (snapshot.version !== 1) {
      throw new CrdtError('invalid_snapshot', `unsupported snapshot version ${String(snapshot.version)}`);
    }
    const doc = new RgaText(replicaId);
    for (const el of snapshot.elements) {
      const element: Element = { id: el.id, origin: el.origin, value: el.value, deletedBy: el.deletedBy };
      const key = idKey(el.id);
      if (doc.byKey.has(key)) throw new CrdtError('invalid_snapshot', `duplicate element ${key}`);
      doc.elements.push(element);
      doc.byKey.set(key, element);
      if (el.origin) doc.bumpDependants(el.origin, 1);
      if (el.deletedBy === null) doc.visible++;
    }
    doc.vector = { ...snapshot.vector };
    doc.clock = Math.max(snapshot.clock, ...Object.values(snapshot.vector), 0);
    doc.pending = [...snapshot.pending];
    for (const op of doc.pending) doc.pendingKeys.add(idKey(op.id));
    return doc;
  }

  get length(): number {
    return this.visible;
  }

  get tombstones(): number {
    return this.elements.length - this.visible;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  text(): string {
    let out = '';
    for (const el of this.elements) if (el.deletedBy === null) out += el.value;
    return out;
  }

  stateVector(): StateVector {
    return { ...this.vector };
  }

  /** Inserts `text` before the visible position `index` and returns the operations to broadcast. */
  insert(index: number, text: string): InsertOp[] {
    this.assertIndex(index, this.visible);
    let origin = index === 0 ? null : this.visibleAt(index - 1).id;
    const ops: InsertOp[] = [];
    for (const value of text) {
      const op: InsertOp = { type: 'insert', id: this.nextId(), prev: this.vector[this.replicaId] ?? 0, origin, value };
      this.integrate(op);
      ops.push(op);
      origin = op.id;
    }
    return ops;
  }

  delete(index: number, count: number): DeleteOp[] {
    this.assertIndex(index, this.visible);
    this.assertIndex(index + count, this.visible);
    const targets: OpId[] = [];
    let seen = 0;
    for (const el of this.elements) {
      if (el.deletedBy !== null) continue;
      if (seen >= index && seen < index + count) targets.push(el.id);
      seen++;
      if (seen >= index + count) break;
    }
    return targets.map((target) => {
      const op: DeleteOp = { type: 'delete', id: this.nextId(), prev: this.vector[this.replicaId] ?? 0, target };
      this.integrate(op);
      return op;
    });
  }

  /**
   * Integrates operations in any order. Operations whose dependencies are missing wait in a
   * pending buffer and are retried whenever something new is integrated; duplicates are ignored.
   */
  apply(ops: readonly Operation[]): ApplyReport {
    const applied: Operation[] = [];
    let duplicates = 0;
    for (const op of ops) {
      assertWellFormed(op);
      const key = idKey(op.id);
      const state = this.readiness(op);
      if (state === 'duplicate' || this.pendingKeys.has(key)) {
        duplicates++;
        continue;
      }
      if (state === 'blocked') {
        this.pending.push(op);
        this.pendingKeys.add(key);
        continue;
      }
      this.integrate(op);
      applied.push(op);
      this.drainPending(applied);
    }
    return { applied, duplicates, pending: this.pending.length };
  }

  /**
   * Removes tombstones whose deletion is covered by `stable` (every known replica has seen it)
   * and which no other element uses as its origin. Such an element can never again be an origin:
   * local edits anchor on visible elements only, and every edit made before a replica saw the
   * deletion has already been delivered, because the replica reported the deletion after sending it.
   */
  collectGarbage(stable: StateVector): number {
    const pinned = new Set<string>();
    for (const op of this.pending) if (op.type === 'insert' && op.origin) pinned.add(idKey(op.origin));
    const removed = new Set<Element>();
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const el = this.elements[i];
      if (el === undefined || el.deletedBy === null || !covers(stable, el.deletedBy)) continue;
      const key = idKey(el.id);
      if ((this.dependants.get(key) ?? 0) > 0 || pinned.has(key)) continue;
      removed.add(el);
      this.byKey.delete(key);
      this.dependants.delete(key);
      if (el.origin) this.bumpDependants(el.origin, -1);
    }
    if (removed.size > 0) this.elements = this.elements.filter((el) => !removed.has(el));
    return removed.size;
  }

  snapshot(): RgaSnapshot {
    return {
      version: 1,
      clock: this.clock,
      vector: this.stateVector(),
      elements: this.elements.map((el) => ({ id: el.id, origin: el.origin, value: el.value, deletedBy: el.deletedBy })),
      pending: [...this.pending],
    };
  }

  /** A position that survives concurrent edits: the id of the element the caret sits after. */
  anchorAt(index: number): OpId | null {
    this.assertIndex(index, this.visible);
    return index === 0 ? null : this.visibleAt(index - 1).id;
  }

  /** Resolves an anchor back to a visible index; anchors on deleted elements collapse to where they were. */
  resolveAnchor(anchor: OpId | null): number {
    if (anchor === null) return 0;
    const target = this.byKey.get(idKey(anchor));
    if (!target) return 0;
    let index = 0;
    for (const el of this.elements) {
      if (el.deletedBy === null) index++;
      if (el === target) return index;
    }
    return index;
  }

  private readiness(op: Operation): Readiness {
    const seen = this.vector[op.id.r] ?? 0;
    if (op.id.c <= seen) return 'duplicate';
    if (op.prev !== seen) return 'blocked';
    if (op.type === 'insert') {
      if (op.origin === null || this.byKey.has(idKey(op.origin))) return 'ready';
      if (covers(this.vector, op.origin)) {
        throw new CrdtError('integrity', `insert ${idKey(op.id)} references collected element ${idKey(op.origin)}`);
      }
      return 'blocked';
    }
    // A target that was integrated and is now gone has been collected, so it was already deleted.
    return this.byKey.has(idKey(op.target)) || covers(this.vector, op.target) ? 'ready' : 'blocked';
  }

  private drainPending(applied: Operation[]): void {
    let progressed = true;
    while (progressed && this.pending.length > 0) {
      progressed = false;
      const waiting = this.pending;
      this.pending = [];
      for (const op of waiting) {
        const state = this.readiness(op);
        if (state === 'blocked') {
          this.pending.push(op);
          continue;
        }
        this.pendingKeys.delete(idKey(op.id));
        if (state === 'ready') {
          this.integrate(op);
          applied.push(op);
          progressed = true;
        }
      }
    }
  }

  private integrate(op: Operation): void {
    if (op.type === 'insert') {
      let pos = op.origin === null ? 0 : this.positionOf(op.origin) + 1;
      while (pos < this.elements.length) {
        const next = this.elements[pos];
        if (next === undefined || compareIds(next.id, op.id) < 0) break;
        pos++;
      }
      const element: Element = { id: op.id, origin: op.origin, value: op.value, deletedBy: null };
      this.elements.splice(pos, 0, element);
      this.byKey.set(idKey(op.id), element);
      if (op.origin) this.bumpDependants(op.origin, 1);
      this.visible++;
    } else {
      const target = this.byKey.get(idKey(op.target));
      if (target && target.deletedBy === null) {
        target.deletedBy = op.id;
        this.visible--;
      }
    }
    this.vector[op.id.r] = op.id.c;
    this.clock = Math.max(this.clock, op.id.c);
  }

  private nextId(): OpId {
    this.clock++;
    return { r: this.replicaId, c: this.clock };
  }

  private positionOf(id: OpId): number {
    const el = this.byKey.get(idKey(id));
    if (!el) throw new CrdtError('integrity', `unknown element ${idKey(id)}`);
    return this.elements.indexOf(el);
  }

  private visibleAt(index: number): Element {
    let seen = 0;
    for (const el of this.elements) {
      if (el.deletedBy !== null) continue;
      if (seen === index) return el;
      seen++;
    }
    throw new CrdtError('out_of_range', `no visible element at ${String(index)}`);
  }

  private bumpDependants(id: OpId, delta: number): void {
    const key = idKey(id);
    const next = (this.dependants.get(key) ?? 0) + delta;
    if (next <= 0) this.dependants.delete(key);
    else this.dependants.set(key, next);
  }

  private assertIndex(index: number, max: number): void {
    if (!Number.isInteger(index) || index < 0 || index > max) {
      throw new CrdtError('out_of_range', `index ${String(index)} outside 0..${String(max)}`);
    }
  }
}

function assertWellFormed(op: Operation): void {
  if (!Number.isInteger(op.id.c) || op.id.c <= 0 || op.prev < 0 || op.prev >= op.id.c) {
    throw new CrdtError('integrity', `malformed clock in ${idKey(op.id)}`);
  }
  if (op.type === 'insert') {
    if ([...op.value].length !== 1) throw new CrdtError('integrity', `insert ${idKey(op.id)} must carry one code point`);
    if (op.origin && compareIds(op.origin, op.id) >= 0) {
      throw new CrdtError('integrity', `insert ${idKey(op.id)} must be newer than its origin`);
    }
  }
}
