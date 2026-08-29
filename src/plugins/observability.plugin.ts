import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { PROBE_PATHS } from "#config/service-registry";
import { requestPathname } from "#lib/request-path";

async function observabilityPlugin(app: FastifyInstance): Promise<void> {
  app.addHook("onResponse", (request, reply, done) => {
    const path = requestPathname(request.url);

    if (PROBE_PATHS.includes(path) && reply.statusCode < 400) {
      done();
      return;
    }

    request.log.info(
      {
        event: "request_completed",
        requestId: request.requestId,
        method: request.method,
        route: request.routeOptions.url ?? "unrouted",
        path,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 100) / 100,
        upstream: request.upstreamService,
        sub: request.user?.userId ?? null,
        pvOutcome: request.pvOutcome,
        ...((request.strippedIdentityHeaders?.length ?? 0) > 0
          ? { strippedIdentityHeaders: request.strippedIdentityHeaders }
          : {}),
      },
      "request completed",
    );
    done();
  });
}

export default fp(observabilityPlugin, {
  name: "observability",
  fastify: "5.x",
  dependencies: ["request-context"],
});
