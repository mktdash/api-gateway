import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { env } from "#config/env";
import {
  GATEWAY_PUBLIC_PATHS,
  SERVICE_REGISTRY,
} from "#config/service-registry";
import { setCorrelationPrincipal } from "#lib/correlation";
import { tokenMissingError, tokenStaleError } from "#lib/errors";
import { securityLogger } from "#lib/logger";
import {
  checkPermissionVersion,
  PV_OUTCOMES,
  rejectsRequest,
  type PermissionVersionMode,
  type PermissionVersionStore,
} from "#lib/permission-version";
import { redis } from "#lib/redis-client";
import {
  isPublicPath,
  matchesPublicRule,
  requestPathname,
} from "#lib/request-path";
import { bearerToken, verifyAccessToken } from "#lib/token-verifier";

export type AuthenticateOptions = {
  readonly permissionVersionStore?: PermissionVersionStore | null | undefined;
  readonly permissionVersionMode?: PermissionVersionMode | undefined;
};

async function authenticatePlugin(
  app: FastifyInstance,
  options: AuthenticateOptions,
): Promise<void> {
  const store = options.permissionVersionStore ?? redis;
  const mode = options.permissionVersionMode ?? env.PERMISSION_VERSION_MODE;

  app.addHook("onRequest", async (request) => {
    const pathname = requestPathname(request.url);

    if (matchesPublicRule(request.method, pathname, GATEWAY_PUBLIC_PATHS)) {
      return;
    }

    if (isPublicPath(request.method, pathname, SERVICE_REGISTRY)) {
      return;
    }

    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      throw tokenMissingError();
    }

    const { principal } = await verifyAccessToken(token);

    const check = await checkPermissionVersion(
      {
        userId: principal.userId,
        organizationId: principal.organizationId,
        ...(principal.workspaceId === undefined
          ? {}
          : { workspaceId: principal.workspaceId }),
      },
      principal.permissionVersion,
      store,
      mode,
    );

    request.pvOutcome = check.outcome;

    if (check.outcome === PV_OUTCOMES.redisDown) {
      request.log.warn(
        {
          event: "pv_check_degraded",
          outcome: check.outcome,
          reason: check.reason,
          userId: principal.userId,
        },
        "permission version check could not read redis; proceeding fail-open",
      );
    } else if (check.outcome === PV_OUTCOMES.missingKey) {
      request.log.debug(
        {
          event: "pv_check_missing_key",
          outcome: check.outcome,
          keyShape: check.keyShape,
          userId: principal.userId,
        },
        "no permission version published for this subject",
      );
    }

    if (rejectsRequest(check, mode)) {
      securityLogger.info(
        {
          event: "pv_check_rejected",
          outcome: check.outcome,
          keyShape: check.keyShape,
          userId: principal.userId,
        },
        "rejected a token whose permissions are no longer current",
      );

      throw tokenStaleError({
        tokenVersion: check.tokenVersion,
        publishedVersion: check.publishedVersion ?? -1,
      });
    }

    request.user = principal;
    setCorrelationPrincipal({
      userId: principal.userId,
      organizationId: principal.organizationId,
      sessionId: principal.sessionId,
      ...(principal.workspaceId === undefined
        ? {}
        : { workspaceId: principal.workspaceId }),
    });
  });

  app.addHook("onResponse", (request, reply, done) => {
    if (reply.statusCode === 401) {
      securityLogger.info(
        {
          event: "authentication_rejected",
          status: reply.statusCode,
          method: request.method,
          path: requestPathname(request.url),
        },
        "authentication rejected",
      );
    }
    done();
  });
}

export default fp<AuthenticateOptions>(authenticatePlugin, {
  name: "authenticate",
  fastify: "5.x",
  dependencies: ["request-context"],
});
