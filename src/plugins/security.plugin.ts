import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { env, isProduction } from "#config/env";
import {
  REQUEST_ID_HEADER,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from "#lib/correlation";
import { logger } from "#lib/logger";

const ALLOWED_REQUEST_HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "idempotency-key",
  REQUEST_ID_HEADER,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
];

const EXPOSED_RESPONSE_HEADERS = [
  REQUEST_ID_HEADER,
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

async function securityPlugin(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
    hsts: isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
  });

  const allowedOrigins = new Set(env.CORS_ALLOWED_ORIGINS);

  if (allowedOrigins.size === 0) {
    logger.warn(
      { event: "cors_allowlist_empty" },
      "CORS_ALLOWED_ORIGINS is empty: every cross-origin browser request will be refused",
    );
  }

  await app.register(cors, {
    origin: (origin, callback) => {
      if (origin === undefined) {
        callback(null, true);
        return;
      }

      callback(null, allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    exposedHeaders: EXPOSED_RESPONSE_HEADERS,
    maxAge: 600,
  });
}

export default fp(securityPlugin, {
  name: "security",
  fastify: "5.x",
});
