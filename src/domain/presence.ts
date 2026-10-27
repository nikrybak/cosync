import type { Cursor, PresenceState, UserInfo } from './messages.js';

interface Entry {
  state: PresenceState;
  lastSeen: number;
}

/** Ephemeral awareness state. Never persisted: it describes who is here now, not the document. */
export class PresenceTracker {
  private readonly entries = new Map<string, Entry>();

  join(sessionId: string, replicaId: string, user: UserInfo, now: number): PresenceState {
    const state: PresenceState = { sessionId, replicaId, user, cursor: null };
    this.entries.set(sessionId, { state, lastSeen: now });
    return state;
  }

  updateCursor(sessionId: string, cursor: Cursor | null, now: number): PresenceState | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    entry.state = { ...entry.state, cursor };
    entry.lastSeen = now;
    return entry.state;
  }

  touch(sessionId: string, now: number): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.lastSeen = now;
  }

  leave(sessionId: string): boolean {
    return this.entries.delete(sessionId);
  }

  /** Removes and returns sessions not heard from within `timeoutMs`. */
  expire(now: number, timeoutMs: number): string[] {
    const expired: string[] = [];
    for (const [sessionId, entry] of this.entries) {
      if (now - entry.lastSeen > timeoutMs) {
        this.entries.delete(sessionId);
        expired.push(sessionId);
      }
    }
    return expired;
  }

  list(except?: string): PresenceState[] {
    const out: PresenceState[] = [];
    for (const [sessionId, entry] of this.entries) if (sessionId !== except) out.push(entry.state);
    return out;
  }

  get size(): number {
    return this.entries.size;
  }
}
