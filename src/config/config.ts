import { z } from 'zod';

const integer = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);

const schema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: integer(3000),
  DB_PATH: z.string().default('./data/cosync.db'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MAX_MESSAGE_BYTES: integer(256 * 1024, 1024),
  MAX_OPS_PER_MESSAGE: integer(5_000, 1),
  BACKPRESSURE_HIGH_WATER_BYTES: integer(4 * 1024 * 1024, 1024),
  PRESENCE_DROP_WATER_BYTES: integer(256 * 1024, 1024),
  HEARTBEAT_MS: integer(5_000, 10),
  PRESENCE_TIMEOUT_MS: integer(15_000, 10),
  SNAPSHOT_EVERY_OPS: integer(500, 1),
  IDLE_UNLOAD_MS: integer(30_000, 0),
  TICK_MS: integer(1_000, 0),
  REPLICA_TTL_MS: integer(7 * 24 * 3600 * 1000, 0),
  SHUTDOWN_GRACE_MS: integer(10_000, 0),
});

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly logLevel: z.infer<typeof schema>['LOG_LEVEL'];
  readonly logPretty: boolean;
  readonly maxMessageBytes: number;
  readonly maxOpsPerMessage: number;
  readonly backpressureHighWaterBytes: number;
  readonly presenceDropWaterBytes: number;
  readonly heartbeatMs: number;
  readonly presenceTimeoutMs: number;
  readonly snapshotEveryOps: number;
  readonly idleUnloadMs: number;
  readonly tickMs: number;
  readonly replicaTtlMs: number;
  readonly shutdownGraceMs: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  if (e.PRESENCE_TIMEOUT_MS <= e.HEARTBEAT_MS) {
    throw new ConfigError(['PRESENCE_TIMEOUT_MS must be greater than HEARTBEAT_MS']);
  }
  return {
    host: e.HOST,
    port: e.PORT,
    dbPath: e.DB_PATH,
    logLevel: e.LOG_LEVEL,
    logPretty: e.LOG_PRETTY,
    maxMessageBytes: e.MAX_MESSAGE_BYTES,
    maxOpsPerMessage: e.MAX_OPS_PER_MESSAGE,
    backpressureHighWaterBytes: e.BACKPRESSURE_HIGH_WATER_BYTES,
    presenceDropWaterBytes: e.PRESENCE_DROP_WATER_BYTES,
    heartbeatMs: e.HEARTBEAT_MS,
    presenceTimeoutMs: e.PRESENCE_TIMEOUT_MS,
    snapshotEveryOps: e.SNAPSHOT_EVERY_OPS,
    idleUnloadMs: e.IDLE_UNLOAD_MS,
    tickMs: e.TICK_MS,
    replicaTtlMs: e.REPLICA_TTL_MS,
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
  };
}
