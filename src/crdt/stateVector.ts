import type { OpId, ReplicaId } from './ids.js';

/**
 * For every replica, the clock of the last operation from that replica that has been
 * integrated. Operations of one replica are integrated strictly in order (see `prev`
 * on operations), so a single number per replica describes everything that was seen.
 */
export type StateVector = Readonly<Record<ReplicaId, number>>;

export function covers(vector: StateVector, id: OpId): boolean {
  return (vector[id.r] ?? 0) >= id.c;
}

/** True when `a` has seen everything `b` has seen. */
export function dominates(a: StateVector, b: StateVector): boolean {
  return Object.entries(b).every(([replica, clock]) => (a[replica] ?? 0) >= clock);
}

export function mergeVectors(a: StateVector, b: StateVector): StateVector {
  const out: Record<ReplicaId, number> = { ...a };
  for (const [replica, clock] of Object.entries(b)) {
    out[replica] = Math.max(out[replica] ?? 0, clock);
  }
  return out;
}

/**
 * Element-wise minimum: the operations every participant has seen. A replica missing
 * from any input counts as 0, which is what makes the result safe to garbage collect against.
 */
export function minVectors(vectors: readonly StateVector[]): StateVector {
  const [first, ...rest] = vectors;
  if (first === undefined) return {};
  const out: Record<ReplicaId, number> = {};
  for (const [replica, clock] of Object.entries(first)) {
    let min = clock;
    for (const v of rest) min = Math.min(min, v[replica] ?? 0);
    if (min > 0) out[replica] = min;
  }
  return out;
}
