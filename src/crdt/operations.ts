import type { OpId } from './ids.js';

/**
 * Every operation carries `prev`, the clock of the previous operation of the same
 * replica (0 for its first one). Lamport clocks have gaps, so without it a receiver
 * could not tell "next operation" from "an operation after one I never got".
 */
export interface InsertOp {
  readonly type: 'insert';
  readonly id: OpId;
  readonly prev: number;
  /** Element this one was typed after; null means the start of the document. */
  readonly origin: OpId | null;
  readonly value: string;
}

export interface DeleteOp {
  readonly type: 'delete';
  readonly id: OpId;
  readonly prev: number;
  readonly target: OpId;
}

export type Operation = InsertOp | DeleteOp;
