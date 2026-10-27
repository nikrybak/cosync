import { covers, RgaText, type Operation } from '../src/crdt/index.js';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type PresenceState,
  type ServerMessage,
  type UserInfo,
} from '../src/domain/messages.js';

/** Stays well below the server's default limit so a large paste never trips it. */
const MAX_OPS_PER_MESSAGE = 1_000;

/** The one thing the client needs from a socket, so the same code runs in browsers and in tests. */
export interface SocketLike {
  send(data: string): void;
}

export interface CollabClientEvents {
  /** `remote` is false for local edits and snapshot loads triggered by our own actions. */
  onText?(text: string, remote: boolean): void;
  onPresence?(peers: ReadonlyMap<string, PresenceState>): void;
  onJoined?(info: { sessionId: string; mode: 'delta' | 'snapshot'; received: number }): void;
  onError?(code: ErrorCode, message: string): void;
}

/**
 * Client half of the sync protocol. Local edits are applied immediately and kept in an
 * outbox until the server acknowledges them, so going offline loses nothing: on the next
 * welcome the client resends whatever the server's state vector does not cover.
 */
export class CollabClient {
  private crdt: RgaText;
  private socket: SocketLike | null = null;
  private joined = false;
  private outbox: Operation[] = [];
  private readonly peerMap = new Map<string, PresenceState>();
  sessionId: string | null = null;
  heartbeatMs = 5_000;

  constructor(
    readonly docId: string,
    readonly replicaId: string,
    readonly user: UserInfo,
    private readonly events: CollabClientEvents = {},
  ) {
    this.crdt = new RgaText(replicaId);
  }

  get doc(): RgaText {
    return this.crdt;
  }

  get text(): string {
    return this.crdt.text();
  }

  get peers(): ReadonlyMap<string, PresenceState> {
    return this.peerMap;
  }

  get unacknowledged(): number {
    return this.outbox.length;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  attach(socket: SocketLike): void {
    this.socket = socket;
    this.joined = false;
    this.send({
      v: PROTOCOL_VERSION,
      type: 'hello',
      docId: this.docId,
      replicaId: this.replicaId,
      stateVector: this.crdt.stateVector(),
      user: this.user,
    });
  }

  detach(): void {
    this.socket = null;
    this.joined = false;
    this.sessionId = null;
    this.peerMap.clear();
    this.events.onPresence?.(this.peerMap);
  }

  receive(raw: string): ServerMessage {
    const message = JSON.parse(raw) as ServerMessage;
    switch (message.type) {
      case 'welcome': {
        this.sessionId = message.sessionId;
        this.heartbeatMs = message.heartbeatMs;
        let received: number;
        if (message.sync.mode === 'delta') {
          received = this.crdt.apply(message.sync.ops).applied.length;
        } else {
          // We are behind the server's trimmed log: adopt its state, then replay our own unsent edits.
          this.crdt = RgaText.fromSnapshot(this.replicaId, message.sync.snapshot);
          this.crdt.apply(this.outbox);
          received = message.sync.snapshot.elements.length;
        }
        this.outbox = this.outbox.filter((op) => !covers(message.stateVector, op.id));
        this.joined = true;
        this.sendOps(this.outbox);
        this.heartbeat();
        this.peerMap.clear();
        for (const peer of message.peers) this.peerMap.set(peer.sessionId, peer);
        this.events.onText?.(this.crdt.text(), true);
        this.events.onPresence?.(this.peerMap);
        this.events.onJoined?.({ sessionId: message.sessionId, mode: message.sync.mode, received });
        break;
      }
      case 'ops':
        if (this.crdt.apply(message.ops).applied.length > 0) this.events.onText?.(this.crdt.text(), true);
        break;
      case 'ack':
        this.outbox = this.outbox.filter((op) => op.id.c > message.upTo);
        break;
      case 'presence':
        for (const id of message.removed) this.peerMap.delete(id);
        for (const peer of message.updated) this.peerMap.set(peer.sessionId, peer);
        this.events.onPresence?.(this.peerMap);
        break;
      case 'error':
        this.events.onError?.(message.code, message.message);
        break;
    }
    return message;
  }

  insert(index: number, text: string): void {
    this.publish(this.crdt.insert(index, text));
  }

  delete(index: number, count: number): void {
    if (count > 0) this.publish(this.crdt.delete(index, count));
  }

  /** Publishes the local selection as anchors; indices are in code points. */
  setCursor(anchor: number, head: number = anchor): void {
    if (!this.joined) return;
    this.send({
      v: PROTOCOL_VERSION,
      type: 'awareness',
      cursor: { anchor: this.crdt.anchorAt(anchor), head: this.crdt.anchorAt(head) },
    });
  }

  heartbeat(): void {
    if (this.joined) this.send({ v: PROTOCOL_VERSION, type: 'heartbeat', stateVector: this.crdt.stateVector() });
  }

  private publish(ops: Operation[]): void {
    if (ops.length === 0) return;
    this.outbox.push(...ops);
    if (this.joined) this.sendOps(ops);
    this.events.onText?.(this.crdt.text(), false);
  }

  private sendOps(ops: readonly Operation[]): void {
    for (let i = 0; i < ops.length; i += MAX_OPS_PER_MESSAGE) {
      this.send({ v: PROTOCOL_VERSION, type: 'ops', ops: ops.slice(i, i + MAX_OPS_PER_MESSAGE) });
    }
  }

  private send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }
}
