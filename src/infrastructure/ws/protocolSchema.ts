import { z } from 'zod';
import { PROTOCOL_VERSION, type ClientMessage } from '../../domain/messages.js';

const replicaId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'replica ids are url-safe and may not use the reserved ~ prefix');
const clock = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const opId = z.strictObject({ r: replicaId, c: clock });
const stateVector = z.record(z.string().min(1).max(64), clock).refine((v) => Object.keys(v).length <= 10_000, {
  message: 'state vector too large',
});

const insertOp = z.strictObject({
  type: z.literal('insert'),
  id: opId,
  prev: z.number().int().nonnegative(),
  origin: z.strictObject({ r: z.string().min(1).max(64), c: clock }).nullable(),
  value: z.string().min(1).max(2),
});
const deleteOp = z.strictObject({
  type: z.literal('delete'),
  id: opId,
  prev: z.number().int().nonnegative(),
  target: z.strictObject({ r: z.string().min(1).max(64), c: clock }),
});
const operation = z.discriminatedUnion('type', [insertOp, deleteOp]);
const anchor = z.strictObject({ r: z.string().min(1).max(64), c: clock }).nullable();

export function clientMessageSchema(maxOps: number) {
  const v = z.literal(PROTOCOL_VERSION);
  return z.discriminatedUnion('type', [
    z.strictObject({
      v,
      type: z.literal('hello'),
      docId: z.string().min(1).max(128),
      replicaId,
      stateVector,
      user: z.strictObject({
        name: z.string().trim().min(1).max(64),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
    }),
    z.strictObject({ v, type: z.literal('ops'), ops: z.array(operation).min(1).max(maxOps) }),
    z.strictObject({ v, type: z.literal('heartbeat'), stateVector }),
    z.strictObject({
      v,
      type: z.literal('awareness'),
      cursor: z.strictObject({ anchor, head: anchor }).nullable(),
    }),
  ]);
}

export type ParseResult =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: 'bad_message' | 'unsupported_version'; readonly detail: string };

export class ClientMessageParser {
  private readonly schema;

  constructor(maxOps: number) {
    this.schema = clientMessageSchema(maxOps);
  }

  parse(raw: string): ParseResult {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, code: 'bad_message', detail: 'message is not valid JSON' };
    }
    if (typeof json === 'object' && json !== null && 'v' in json && json.v !== PROTOCOL_VERSION) {
      return { ok: false, code: 'unsupported_version', detail: `server speaks protocol v${PROTOCOL_VERSION}` };
    }
    const result = this.schema.safeParse(json);
    if (!result.success) {
      const issue = result.error.issues[0];
      return {
        ok: false,
        code: 'bad_message',
        detail: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid',
      };
    }
    // The schema mirrors ClientMessage; this assignment is where the compiler checks that it does.
    const message: ClientMessage = result.data;
    return { ok: true, message };
  }
}
