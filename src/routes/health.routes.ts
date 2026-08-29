import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "#config/env";
import { BREAKER_STATES, breakerSnapshots } from "#lib/circuit-breaker";
import { permissionVersionStats } from "#lib/permission-version";
import { checkRedis } from "#lib/redis-client";
import { jwksState } from "#lib/token-verifier";
import { activeServices, inactiveServiceNames } from "#config/service-registry";

const livenessResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  uptimeSeconds: z.number(),
});

const readinessResponseSchema = z.object({
  status: z.enum(["ready", "degraded"]),
  checks: z.object({
    redis: z.object({
      configured: z.boolean(),
      ok: z.boolean(),
      status: z.string(),
    }),
  }),
});

const statusResponseSchema = z.object({
  service: z.string(),
  services: z.object({
    active: z.array(z.object({ name: z.string(), upstream: z.string() })),
    inactive: z.array(z.string()),
  }),
  jwks: z.object({
    uri: z.string(),
    algorithm: z.string(),
    fetchFailures: z.number(),
    lastFailure: z.string().nullable(),
  }),
  permissionVersion: z.object({
    namespace: z.string(),
    mode: z.enum(["off", "monitor", "enforce"]),
    comparing: z.boolean(),
    outcomes: z.record(z.string(), z.number()),
  }),
  breakers: z.array(
    z.object({
      name: z.string(),
      state: z.enum([
        BREAKER_STATES.closed,
        BREAKER_STATES.open,
        BREAKER_STATES.halfOpen,
      ]),
      consecutiveFailures: z.number(),
      failureThreshold: z.number(),
      retryAfterSeconds: z.number(),
    }),
  ),
});

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        operationId: "getGatewayLiveness",
        tags: ["health"],
        summary: "Liveness — process only, no dependency checks",
        response: { 200: livenessResponseSchema },
      },
    },
    async (_request, reply) => {
      await reply.header("cache-control", "no-store").send({
        status: "ok" as const,
        service: env.SERVICE_NAME,
        uptimeSeconds: Math.round(process.uptime()),
      });
    },
  );

  app.get(
    "/ready",
    {
      schema: {
        operationId: "getGatewayReadiness",
        tags: ["health"],
        summary: "Readiness — Argus's own dependencies, never an upstream",
        response: {
          200: readinessResponseSchema,
          503: readinessResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const redis = await checkRedis();
      const ready = redis.configured ? redis.ok : true;

      await reply
        .code(ready ? 200 : 503)
        .header("cache-control", "no-store")
        .send({
          status: ready ? ("ready" as const) : ("degraded" as const),
          checks: {
            redis: {
              configured: redis.configured,
              ok: redis.ok,
              status: redis.status,
            },
          },
        });
    },
  );

  app.get(
    "/status",
    {
      schema: {
        operationId: "getGatewayStatus",
        tags: ["health"],
        summary: "Breaker state, JWKS health, and permission-version liveness",
        response: { 200: statusResponseSchema },
      },
    },
    async (_request, reply) => {
      await reply.header("cache-control", "no-store").send({
        service: env.SERVICE_NAME,
        services: {
          active: activeServices().map((service) => ({
            name: service.name,
            upstream: service.upstream,
          })),
          inactive: [...inactiveServiceNames()],
        },
        jwks: jwksState(),
        permissionVersion: permissionVersionStats(),
        breakers: breakerSnapshots().map((snapshot) => ({
          name: snapshot.name,
          state: snapshot.state,
          consecutiveFailures: snapshot.consecutiveFailures,
          failureThreshold: snapshot.failureThreshold,
          retryAfterSeconds: snapshot.retryAfterSeconds,
        })),
      });
    },
  );
};
