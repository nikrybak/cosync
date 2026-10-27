import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { CollaborationService } from './application/collaborationService.js';
import { DocumentRegistry } from './application/documentRegistry.js';
import { DocumentService } from './application/documentService.js';
import type { Config } from './config/config.js';
import type { Clock, DocumentRepository, Logger } from './domain/ports.js';
import { registerHttpApi } from './infrastructure/http/httpApi.js';
import { createLogger } from './infrastructure/observability/logger.js';
import { PrometheusMetrics } from './infrastructure/observability/prometheusMetrics.js';
import { SqliteDocumentRepository } from './infrastructure/persistence/sqliteDocumentRepository.js';
import { randomId, systemClock } from './infrastructure/systemClock.js';
import { WsTransport } from './infrastructure/ws/wsTransport.js';

export interface ServerOverrides {
  readonly repository?: DocumentRepository;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly publicDir?: string | null;
}

/** Composition root: the only place that knows every concrete adapter. */
export class CosyncServer {
  private closed = false;

  private constructor(
    readonly config: Config,
    readonly http: FastifyInstance,
    readonly registry: DocumentRegistry,
    readonly documents: DocumentService,
    readonly metrics: PrometheusMetrics,
    private readonly transport: WsTransport,
    private readonly repository: DocumentRepository,
    private readonly logger: Logger,
  ) {}

  static async create(config: Config, overrides: ServerOverrides = {}): Promise<CosyncServer> {
    const logger = overrides.logger ?? createLogger({ level: config.logLevel, pretty: config.logPretty });
    const clock = overrides.clock ?? systemClock;
    const repository = overrides.repository ?? new SqliteDocumentRepository(config.dbPath);
    const metrics = new PrometheusMetrics();

    const registry = new DocumentRegistry(
      {
        repository,
        clock,
        metrics,
        logger,
        settings: {
          presenceTimeoutMs: config.presenceTimeoutMs,
          heartbeatMs: config.heartbeatMs,
          snapshotEveryOps: config.snapshotEveryOps,
          replicaTtlMs: config.replicaTtlMs,
        },
      },
      { idleUnloadMs: config.idleUnloadMs, tickMs: config.tickMs },
    );
    const collaboration = new CollaborationService(registry, metrics, logger, () => randomId());
    const documents = new DocumentService(repository, registry, clock, () => randomId());
    const transport = new WsTransport(collaboration, metrics, logger, {
      path: '/ws',
      maxMessageBytes: config.maxMessageBytes,
      maxOpsPerMessage: config.maxOpsPerMessage,
      backpressureHighWaterBytes: config.backpressureHighWaterBytes,
      presenceDropWaterBytes: config.presenceDropWaterBytes,
      pingIntervalMs: Math.max(config.presenceTimeoutMs, 1_000),
    });

    const http = Fastify({ logger: false, bodyLimit: config.maxMessageBytes * 2 });
    await registerHttpApi(http, {
      documents,
      registry,
      metrics,
      logger,
      publicDir: overrides.publicDir === undefined ? resolve(process.cwd(), 'public') : overrides.publicDir,
      connectionCount: () => transport.connectionCount,
    });
    transport.attach(http.server);
    registry.start();
    return new CosyncServer(config, http, registry, documents, metrics, transport, repository, logger);
  }

  async listen(): Promise<string> {
    const address = await this.http.listen({ host: this.config.host, port: this.config.port });
    this.logger.info({ address }, 'cosync listening');
    return address;
  }

  /** The port actually bound, useful when listening on port 0. */
  get port(): number {
    const address = this.http.server.address();
    return typeof address === 'object' && address !== null ? address.port : this.config.port;
  }

  /**
   * Graceful shutdown: refuse new sockets, flush a snapshot of every open document and
   * disconnect its sessions, wait for sockets to close, then stop HTTP and the database.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.logger.info({}, 'shutting down');
    await this.registry.shutdown();
    await this.transport.close(this.config.shutdownGraceMs);
    await this.http.close();
    this.repository.close();
    this.logger.info({}, 'shutdown complete');
  }
}
