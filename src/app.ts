import underPressure from "@fastify/under-pressure";
import { fastify, LogController } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { env, trustProxy } from "#config/env";
import { logger } from "#lib/logger";
import type {
  PermissionVersionMode,
  PermissionVersionStore,
} from "#lib/permission-version";
import authenticatePlugin from "#plugins/authenticate.plugin";
import errorHandlerPlugin from "#plugins/error-handler.plugin";
import observabilityPlugin from "#plugins/observability.plugin";
import rateLimitPlugin from "#plugins/rate-limit.plugin";
import requestContextPlugin, {
  genReqId,
} from "#plugins/request-context.plugin";
import securityPlugin from "#plugins/security.plugin";
import { healthRoutes } from "#routes/health.routes";
import { openapiRoutes } from "#routes/openapi.routes";
import { proxyRoutes } from "#routes/proxy.routes";

export type BuildAppOptions = {
  readonly permissionVersionStore?: PermissionVersionStore | null | undefined;
  readonly permissionVersionMode?: PermissionVersionMode | undefined;
};

export async function buildApp(options: BuildAppOptions = {}) {
  const app = fastify({
    loggerInstance: logger,
    genReqId,
    trustProxy,
    bodyLimit: env.BODY_LIMIT_BYTES,
    requestTimeout: env.REQUEST_TIMEOUT_MS,
    logController: new LogController({ disableRequestLogging: true }),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(requestContextPlugin);
  await app.register(securityPlugin);
  await app.register(underPressure, {
    maxEventLoopDelay: env.MAX_EVENT_LOOP_DELAY_MS,
    maxEventLoopUtilization: env.MAX_EVENT_LOOP_UTILIZATION,
    exposeStatusRoute: false,
    retryAfter: env.PRESSURE_RETRY_AFTER_SECONDS,
  });
  await app.register(healthRoutes);
  await app.register(openapiRoutes);
  await app.register(authenticatePlugin, {
    ...(options.permissionVersionStore === undefined
      ? {}
      : { permissionVersionStore: options.permissionVersionStore }),
    ...(options.permissionVersionMode === undefined
      ? {}
      : { permissionVersionMode: options.permissionVersionMode }),
  });
  await app.register(rateLimitPlugin);
  await app.register(observabilityPlugin);
  await app.register(proxyRoutes);
  await app.ready();

  return app;
}

export type GatewayApp = Awaited<ReturnType<typeof buildApp>>;
