import { Redis } from "ioredis";
import { env, redisConnection, redisTargetRedacted } from "#config/env";
import { toRedisAuthOptions, toRedisTlsOptions } from "#config/redis-url";
import { logger } from "./logger.ts";

const log = logger.child({ component: "redis" });

export const REDIS_EVENTS = {
  connectionError: "redis_connection_error",
  connectionClosed: "redis_connection_closed",
  unconfigured: "redis_unconfigured",
  configured: "redis_configured",
} as const;

function createClient(): Redis | null {
  if (redisConnection === null) {
    return null;
  }

  const tls = toRedisTlsOptions(redisConnection.tls);

  return new Redis({
    host: redisConnection.host,
    port: redisConnection.port,
    db: redisConnection.db,
    ...toRedisAuthOptions(redisConnection),
    ...(tls === false ? {} : { tls }),
    connectionName: env.SERVICE_NAME,
    lazyConnect: true,
    connectTimeout: 5_000,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
}

export const redis: Redis | null = createClient();

if (redis === null) {
  log.warn(
    { event: REDIS_EVENTS.unconfigured },
    "REDIS_HOST is unset: the permission-version check cannot run and rate limiting falls back to per-instance in-memory counters",
  );
} else {
  log.info(
    { event: REDIS_EVENTS.configured, target: redisTargetRedacted },
    "redis configured",
  );

  redis.on("error", (error: Error) => {
    log.error(
      { err: error, event: REDIS_EVENTS.connectionError },
      "redis connection error",
    );
  });

  redis.on("end", () => {
    log.warn(
      { event: REDIS_EVENTS.connectionClosed },
      "redis connection closed",
    );
  });
}

export function isRedisConfigured(): boolean {
  return redis !== null;
}

export async function connectRedis(): Promise<void> {
  if (redis?.status !== "wait") {
    return;
  }

  await redis.connect();
}

export type RedisHealth = {
  readonly configured: boolean;
  readonly status: string;
  readonly ok: boolean;
};

export async function checkRedis(): Promise<RedisHealth> {
  if (redis === null) {
    return { configured: false, status: "unconfigured", ok: false };
  }

  try {
    await redis.ping();
    return { configured: true, status: redis.status, ok: true };
  } catch {
    return { configured: true, status: redis.status, ok: false };
  }
}

export async function closeRedis(): Promise<void> {
  if (redis === null || redis.status === "end") {
    return;
  }

  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}
