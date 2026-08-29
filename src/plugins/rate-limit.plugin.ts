import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { env } from "#config/env";
import { rateLimitedError } from "#lib/errors";
import { logger, securityLogger } from "#lib/logger";
import { redis } from "#lib/redis-client";

function rateLimitKey(request: FastifyRequest): string {
  const principal = request.user;

  if (principal !== null) {
    return `argus:rl:user:${principal.userId}`;
  }

  return `argus:rl:ip:${request.ip}`;
}

async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  if (redis === null) {
    logger.warn(
      { event: "rate_limit_store_in_memory" },
      "rate limiting is using per-instance in-memory counters: the effective limit is multiplied by the replica count",
    );
  }

  await app.register(rateLimit, {
    global: true,
    max: (request: FastifyRequest) =>
      request.user === null ? env.RATE_LIMIT_ANONYMOUS_MAX : env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: rateLimitKey,
    nameSpace: "",
    ...(redis === null ? {} : { redis }),
    skipOnError: true,
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    onExceeded: (request: FastifyRequest, key: string) => {
      securityLogger.warn(
        {
          event: "rate_limit_exceeded",
          keyKind: request.user === null ? "ip" : "user",
          key,
        },
        "rate limit exceeded",
      );
    },
    errorResponseBuilder: (_request, context) =>
      rateLimitedError(Math.max(1, Math.ceil(context.ttl / 1000))),
  });
}

export default fp(rateLimitPlugin, {
  name: "rate-limit",
  fastify: "5.x",
  dependencies: ["authenticate"],
});
