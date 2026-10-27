import { loadConfig } from './config/config.js';
import { createLogger } from './infrastructure/observability/logger.js';
import { CosyncServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, pretty: config.logPretty });
  const server = await CosyncServer.create(config, { logger });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'signal received');
    const force = setTimeout(() => {
      logger.error({}, 'shutdown timed out');
      process.exit(1);
    }, config.shutdownGraceMs + 5_000);
    force.unref();
    server
      .close()
      .then(() => {
        logger.flush();
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => {
    stop('SIGINT');
  });
  process.on('SIGTERM', () => {
    stop('SIGTERM');
  });

  await server.listen();
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
