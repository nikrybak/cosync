import { DocumentActor, type ActorDependencies } from '../domain/documentActor.js';

export interface RegistrySettings {
  /** How long a document with no sessions stays in memory before it is snapshotted and dropped. */
  readonly idleUnloadMs: number;
  /** Housekeeping interval; 0 disables the timer so tests can drive `tickAll` themselves. */
  readonly tickMs: number;
}

interface Entry {
  readonly actor: DocumentActor;
  refs: number;
  unloadTimer: NodeJS.Timeout | null;
}

/**
 * Keeps at most one actor per document id and loads or unloads actors on demand.
 * Reference counting is per session, so an open editor tab keeps its document hot.
 */
export class DocumentRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly unloading = new Map<string, Promise<void>>();
  private ticker: NodeJS.Timeout | null = null;

  constructor(
    private readonly actorDeps: ActorDependencies,
    private readonly settings: RegistrySettings,
  ) {}

  start(): void {
    if (this.settings.tickMs <= 0 || this.ticker) return;
    this.ticker = setInterval(() => {
      this.tickAll().catch((err: unknown) => {
        this.actorDeps.logger.error({ err }, 'housekeeping failed');
      });
    }, this.settings.tickMs);
    this.ticker.unref();
  }

  get openDocuments(): number {
    return this.entries.size;
  }

  async acquire(docId: string): Promise<DocumentActor> {
    // A document being unloaded must finish its final snapshot before it is reloaded.
    await this.unloading.get(docId);
    let entry = this.entries.get(docId);
    if (!entry) {
      entry = { actor: DocumentActor.load(docId, this.actorDeps), refs: 0, unloadTimer: null };
      this.entries.set(docId, entry);
      this.actorDeps.metrics.increment('cosync_documents_loaded_total');
      this.actorDeps.metrics.gauge('cosync_documents_open', this.entries.size);
    }
    entry.refs++;
    if (entry.unloadTimer) {
      clearTimeout(entry.unloadTimer);
      entry.unloadTimer = null;
    }
    return entry.actor;
  }

  release(docId: string): void {
    const entry = this.entries.get(docId);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.unloadTimer) return;
    entry.unloadTimer = setTimeout(() => {
      void this.unload(docId);
    }, this.settings.idleUnloadMs);
    entry.unloadTimer.unref();
  }

  async withDocument<T>(docId: string, fn: (actor: DocumentActor) => Promise<T>): Promise<T> {
    const actor = await this.acquire(docId);
    try {
      return await fn(actor);
    } finally {
      this.release(docId);
    }
  }

  async tickAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.actor.tick()));
  }

  async unload(docId: string): Promise<void> {
    const entry = this.entries.get(docId);
    if (!entry || entry.refs > 0) return;
    this.entries.delete(docId);
    const done = entry.actor.close('document unloaded').finally(() => {
      this.unloading.delete(docId);
    });
    this.unloading.set(docId, done);
    this.actorDeps.metrics.increment('cosync_documents_unloaded_total');
    this.actorDeps.metrics.gauge('cosync_documents_open', this.entries.size);
    await done;
  }

  /** Writes a final snapshot of every open document and disconnects its sessions. */
  async shutdown(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    const entries = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(
      entries.map(async ([, entry]) => {
        if (entry.unloadTimer) clearTimeout(entry.unloadTimer);
        await entry.actor.close('server shutting down');
      }),
    );
    await Promise.all(this.unloading.values());
    this.actorDeps.metrics.gauge('cosync_documents_open', 0);
  }
}
