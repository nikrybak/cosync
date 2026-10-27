import type { DocumentActor } from '../domain/documentActor.js';
import { ProtocolError } from '../domain/errors.js';
import type { ClientMessage } from '../domain/messages.js';
import type { Logger, Metrics, Peer } from '../domain/ports.js';
import type { DocumentRegistry } from './documentRegistry.js';

interface Joined {
  readonly docId: string;
  readonly actor: DocumentActor;
}

/**
 * One connected client. The transport hands it validated messages; it owns the
 * join/leave lifecycle so the actor's reference count can never leak.
 */
export class ClientSession {
  private joined: Joined | null = null;
  private joining = false;
  private ended = false;

  constructor(
    readonly sessionId: string,
    private readonly peer: Peer,
    private readonly registry: DocumentRegistry,
    private readonly logger: Logger,
    private readonly onEnd: () => void,
  ) {}

  get docId(): string | null {
    return this.joined?.docId ?? null;
  }

  async handle(message: ClientMessage): Promise<void> {
    if (message.type === 'hello') {
      await this.join(message);
      return;
    }
    const joined = this.joined;
    if (!joined) throw new ProtocolError('not_joined', `send hello before ${message.type}`);
    switch (message.type) {
      case 'ops':
        await joined.actor.submit(this.sessionId, message.ops);
        return;
      case 'heartbeat':
        await joined.actor.heartbeat(this.sessionId, message.stateVector);
        return;
      case 'awareness':
        await joined.actor.awareness(this.sessionId, message.cursor);
        return;
    }
  }

  /** Idempotent; called by the transport whenever the socket goes away. */
  async disconnect(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.onEnd();
    await this.leaveJoined();
  }

  private async leaveJoined(): Promise<void> {
    const joined = this.joined;
    this.joined = null;
    if (!joined) return;
    try {
      await joined.actor.leave(this.sessionId);
    } catch (err: unknown) {
      this.logger.warn({ err, sessionId: this.sessionId }, 'leave failed');
    } finally {
      this.registry.release(joined.docId);
    }
  }

  private async join(message: Extract<ClientMessage, { type: 'hello' }>): Promise<void> {
    if (this.joined || this.joining) throw new ProtocolError('already_joined', 'a connection joins one document');
    this.joining = true;
    try {
      const actor = await this.registry.acquire(message.docId);
      try {
        await actor.join(this.sessionId, this.peer, {
          replicaId: message.replicaId,
          stateVector: message.stateVector,
          user: message.user,
        });
      } catch (err) {
        this.registry.release(message.docId);
        throw err;
      }
      this.joined = { docId: message.docId, actor };
      // The socket may have closed while we were loading the document.
      if (this.ended) await this.leaveJoined();
    } finally {
      this.joining = false;
    }
  }
}

export class CollaborationService {
  private active = 0;

  constructor(
    private readonly registry: DocumentRegistry,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly newSessionId: () => string,
  ) {}

  connect(peer: Peer): ClientSession {
    const sessionId = this.newSessionId();
    this.active++;
    this.metrics.gauge('cosync_sessions', this.active);
    return new ClientSession(sessionId, peer, this.registry, this.logger.child({ sessionId }), () => {
      this.active--;
      this.metrics.gauge('cosync_sessions', this.active);
    });
  }
}
