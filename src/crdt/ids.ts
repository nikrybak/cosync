/**
 * An operation id: the Lamport timestamp of the operation plus the replica that
 * produced it. The pair is globally unique because a replica never reuses a clock value.
 */
export interface OpId {
  readonly r: string;
  readonly c: number;
}

export type ReplicaId = string;

/** Total order over ids: clock first, replica id as the tie breaker. */
export function compareIds(a: OpId, b: OpId): number {
  if (a.c !== b.c) return a.c - b.c;
  if (a.r === b.r) return 0;
  return a.r < b.r ? -1 : 1;
}

export function idKey(id: OpId): string {
  return `${id.c}@${id.r}`;
}

export function sameId(a: OpId | null, b: OpId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.c === b.c && a.r === b.r;
}
