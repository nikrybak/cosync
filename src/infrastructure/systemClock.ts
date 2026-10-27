import { randomBytes } from 'node:crypto';
import type { Clock } from '../domain/ports.js';

export const systemClock: Clock = { now: () => Date.now() };

/** URL-safe random ids; 72 bits is plenty for document and session ids. */
export function randomId(bytes = 9): string {
  return randomBytes(bytes).toString('base64url');
}
