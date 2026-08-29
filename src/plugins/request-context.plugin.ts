import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  createRequestId,
  normalizeRequestId,
  parseTraceparent,
  REQUEST_ID_HEADER,
  runWithCorrelation,
  type RequestCorrelation,
} from "#lib/correlation";
import {
  FORWARDED_FOR_HEADER,
  stripIdentityHeaders,
  type IdentityHeader,
} from "#lib/identity-headers";
import { securityLogger } from "#lib/logger";

const REAL_IP_HEADER = "x-real-ip";

export function genReqId(request: {
  headers: Record<string, unknown>;
}): string {
  return (
    normalizeRequestId(request.headers[REQUEST_ID_HEADER]) ?? createRequestId()
  );
}

function buildCorrelation(request: FastifyRequest): RequestCorrelation {
  const requestId =
    normalizeRequestId(request.headers[REQUEST_ID_HEADER]) ??
    normalizeRequestId(request.id) ??
    createRequestId();

  const traceparent = parseTraceparent(request.headers.traceparent);

  return traceparent === undefined
    ? { requestId }
    : { requestId, traceId: traceparent.traceId, spanId: traceparent.spanId };
}

async function requestContextPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("user", null);
  app.decorateRequest("upstreamService", null);
  app.decorateRequest("pvOutcome", null);
  app.decorateRequest("strippedIdentityHeaders", null);

  app.decorateRequest("requestId", {
    getter(this: FastifyRequest): string {
      return this.id;
    },
  });

  app.addHook("onRequest", (request, reply, done) => {
    const stripped: readonly IdentityHeader[] = stripIdentityHeaders(
      request.headers,
    );

    request.strippedIdentityHeaders = stripped;

    if (stripped.length > 0) {
      securityLogger.warn(
        {
          event: "identity_header_injection_blocked",
          headers: stripped,
          method: request.method,
          path: request.url.split("?", 1)[0],
        },
        "client supplied identity headers; stripped before routing",
      );
    }

    request.headers[FORWARDED_FOR_HEADER] = request.ip;
    request.headers[REAL_IP_HEADER] = request.ip;

    const correlation = buildCorrelation(request);
    void reply.header(REQUEST_ID_HEADER, correlation.requestId);

    runWithCorrelation(correlation, done);
  });
}

export default fp(requestContextPlugin, {
  name: "request-context",
  fastify: "5.x",
});
