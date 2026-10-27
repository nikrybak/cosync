import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DocumentService } from '../../application/documentService.js';
import type { DocumentRegistry } from '../../application/documentRegistry.js';
import { DomainError } from '../../domain/errors.js';
import type { Logger } from '../../domain/ports.js';
import type { PrometheusMetrics } from '../observability/prometheusMetrics.js';

export interface HttpApiDependencies {
  readonly documents: DocumentService;
  readonly registry: DocumentRegistry;
  readonly metrics: PrometheusMetrics;
  readonly logger: Logger;
  readonly publicDir: string | null;
  readonly connectionCount: () => number;
}

const createBody = z.strictObject({ text: z.string().max(100_000).optional() }).optional();
const docParams = z.object({ docId: z.string().min(1).max(128) });

export async function registerHttpApi(app: FastifyInstance, deps: HttpApiDependencies): Promise<void> {
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.httpStatus).send({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'bad_request', message: err.issues.map((i) => i.message).join('; ') });
    }
    const status = typeof err === 'object' && err !== null && 'statusCode' in err ? Number(err.statusCode) : 500;
    if (status >= 500) deps.logger.error({ err }, 'request failed');
    return reply.status(status).send({ error: status >= 500 ? 'internal' : 'bad_request', message: String(err) });
  });

  app.post('/api/docs', async (request, reply) => {
    const body = createBody.parse(request.body ?? undefined);
    const created = await deps.documents.create(body?.text);
    return reply.status(201).send(created);
  });

  app.get('/api/docs/:docId', async (request) => {
    const { docId } = docParams.parse(request.params);
    return deps.documents.describe(docId);
  });

  app.get('/api/docs/:docId/text', async (request, reply) => {
    const { docId } = docParams.parse(request.params);
    const summary = await deps.documents.describe(docId);
    return reply.type('text/plain; charset=utf-8').send(summary.text);
  });

  app.get('/api/docs/:docId/history', (request) => {
    const { docId } = docParams.parse(request.params);
    return { docId, historyLength: deps.documents.historyLength(docId) };
  });

  app.get('/health', () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    openDocuments: deps.registry.openDocuments,
    connections: deps.connectionCount(),
  }));

  app.get('/metrics', (_request, reply) => {
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(deps.metrics.render());
  });

  if (deps.publicDir && existsSync(deps.publicDir)) {
    await app.register(fastifyStatic, { root: deps.publicDir, index: ['index.html'] });
  }
}
