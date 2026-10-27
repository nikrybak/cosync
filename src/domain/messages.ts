import type { OpId, Operation, RgaSnapshot, StateVector } from '../crdt/index.js';

/**
 * Wire protocol shared by the server and the browser client. Plain types only, so the
 * client can import them without pulling the validation library into the bundle.
 */
export const PROTOCOL_VERSION = 1;

export interface UserInfo {
  readonly name: string;
  readonly color: string;
}

/** Selection expressed as CRDT anchors so it stays attached to text while others type. */
export interface Cursor {
  readonly anchor: OpId | null;
  readonly head: OpId | null;
}

export interface PresenceState {
  readonly sessionId: string;
  readonly replicaId: string;
  readonly user: UserInfo;
  readonly cursor: Cursor | null;
}

export type ClientMessage =
  | {
      readonly v: 1;
      readonly type: 'hello';
      readonly docId: string;
      readonly replicaId: string;
      readonly stateVector: StateVector;
      readonly user: UserInfo;
    }
  | { readonly v: 1; readonly type: 'ops'; readonly ops: readonly Operation[] }
  | { readonly v: 1; readonly type: 'heartbeat'; readonly stateVector: StateVector }
  | { readonly v: 1; readonly type: 'awareness'; readonly cursor: Cursor | null };

export type SyncPayload =
  | { readonly mode: 'delta'; readonly ops: readonly Operation[] }
  | { readonly mode: 'snapshot'; readonly snapshot: RgaSnapshot };

export type ErrorCode =
  | 'bad_message'
  | 'unsupported_version'
  | 'not_joined'
  | 'already_joined'
  | 'doc_not_found'
  | 'forbidden_op'
  | 'integrity'
  | 'internal';

export type ServerMessage =
  | {
      readonly v: 1;
      readonly type: 'welcome';
      readonly sessionId: string;
      readonly docId: string;
      readonly stateVector: StateVector;
      readonly sync: SyncPayload;
      readonly peers: readonly PresenceState[];
      readonly heartbeatMs: number;
    }
  | { readonly v: 1; readonly type: 'ops'; readonly ops: readonly Operation[] }
  | {
      readonly v: 1;
      readonly type: 'presence';
      readonly updated: readonly PresenceState[];
      readonly removed: readonly string[];
    }
  | { readonly v: 1; readonly type: 'error'; readonly code: ErrorCode; readonly message: string };

/** WebSocket close codes in the application range (4000-4999). */
export const CloseCode = {
  ProtocolError: 4400,
  NotFound: 4404,
  PresenceTimeout: 4408,
  ServerShutdown: 1001,
  TryAgainLater: 1013,
} as const;
