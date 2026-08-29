import closeWithGrace from "close-with-grace";
import { buildApp } from "./app.ts";
import { env } from "#config/env";
import { inactiveServiceNames } from "#config/service-registry";
import { logger } from "#lib/logger";
import {
  checkRedis,
  closeRedis,
  connectRedis,
  isRedisConfigured,
} from "#lib/redis-client";

const SHUTDOWN_GRACE_MS = 10_000;

async function connectDependencies(): Promise<void> {
  if (!isRedisConfigured()) {
    logger.warn(
      { event: "redis_unconfigured" },
      "REDIS_HOST is unset: rate limiting is per-instance and the permission-version check cannot run",
    );
    return;
  }

  try {
    await connectRedis();
  } catch (error) {
    logger.warn(
      { err: error, event: "redis_connect_failed" },
      "redis is configured but unreachable at boot: continuing fail-open, rate limiting is per-instance",
    );
    return;
  }

  const health = await checkRedis();

  if (health.ok) {
    logger.info(
      { event: "redis_connected", status: health.status },
      "redis connected",
    );
    return;
  }

  logger.warn(
    { event: "redis_unavailable", status: health.status },
    "redis is configured but not answering: continuing fail-open",
  );
}

try {
  logger.info(
    {
      event: "startup",
      nodeEnv: env.NODE_ENV,
      nodeVersion: process.version,
      trustProxy: env.TRUST_PROXY,
    },
    "starting api-gateway",
  );

  await connectDependencies();

  const app = await buildApp();

  const dormant = inactiveServiceNames();
  if (dormant.length > 0) {
    logger.info(
      { event: "upstreams_inactive", services: dormant },
      "services with no configured upstream URL were not registered",
    );
  }

  closeWithGrace(
    { delay: SHUTDOWN_GRACE_MS, logger },
    async ({ err, signal, manual }) => {
      if (err) {
        logger.fatal(
          { err, event: "shutdown" },
          "shutting down after an unhandled error",
        );
      } else {
        logger.info({ event: "shutdown", signal, manual }, "shutting down");
      }
      await app.close();
      await closeRedis();
    },
  );

  await app.listen({ port: env.PORT, host: env.HOST });

  logger.info(
    { event: "startup_complete", port: env.PORT, host: env.HOST },
    "api-gateway listening",
  );
} catch (error) {
  logger.fatal({ err: error, event: "startup_failed" }, "startup failed");
  await closeRedis().catch(() => undefined);
  process.exit(1);
}
