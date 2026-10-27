import { DocumentNotFoundError } from '../domain/errors.js';
import type { Clock, DocumentRepository } from '../domain/ports.js';
import type { DocumentRegistry } from './documentRegistry.js';

export interface DocumentSummary {
  readonly docId: string;
  readonly text: string;
  readonly length: number;
  readonly createdAt: string;
  readonly historyLength: number;
  readonly retainedOps: number;
  readonly tombstones: number;
  readonly activeSessions: number;
}

/** HTTP-facing use cases. Reads go through the actor so they observe the same order as live edits. */
export class DocumentService {
  constructor(
    private readonly repository: DocumentRepository,
    private readonly registry: DocumentRegistry,
    private readonly clock: Clock,
    private readonly newDocumentId: () => string,
  ) {}

  async create(initialText = ''): Promise<{ docId: string }> {
    const docId = this.newDocumentId();
    this.repository.create(docId, this.clock.now());
    if (initialText.length > 0) {
      await this.registry.withDocument(docId, (actor) => actor.edit(0, initialText));
    }
    return { docId };
  }

  async describe(docId: string): Promise<DocumentSummary> {
    const stats = this.repository.stats(docId);
    if (!stats) throw new DocumentNotFoundError(docId);
    const view = await this.registry.withDocument(docId, (actor) => actor.read());
    const fresh = this.repository.stats(docId) ?? stats;
    return {
      docId,
      text: view.text,
      length: view.length,
      createdAt: new Date(fresh.createdAt).toISOString(),
      historyLength: fresh.historyLength,
      retainedOps: view.retainedOps,
      tombstones: view.tombstones,
      activeSessions: view.sessions,
    };
  }

  historyLength(docId: string): number {
    const stats = this.repository.stats(docId);
    if (!stats) throw new DocumentNotFoundError(docId);
    return stats.historyLength;
  }
}
