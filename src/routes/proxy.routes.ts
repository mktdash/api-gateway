import httpProxy from "@fastify/http-proxy";
import type { FastifyInstance } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { env } from "#config/env";
import { activeServices, type ActiveService } from "#config/service-registry";
import {
  BREAKER_STATES,
  CircuitBreaker,
  getBreaker,
} from "#lib/circuit-breaker";
import {
  REQUEST_ID_HEADER,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from "#lib/correlation";
import { upstreamUnavailableError } from "#lib/errors";
import {
  FORWARDED_FOR_HEADER,
  IDENTITY_HEADERS,
  identityHeadersFor,
  type VerifiedPrincipal,
} from "#lib/identity-headers";
import { logger } from "#lib/logger";

export const PROXY_EVENTS = {
  breakerTransition: "breaker_state_changed",
  breakerRejected: "upstream_request_shed",
  upstreamError: "upstream_request_failed",
} as const;

const IDEMPOTENT_METHODS = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"] as const;

const PROXIED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
] as const;

function breakerFor(service: ActiveService): CircuitBreaker {
  return getBreaker(
    service.name,
    () =>
      new CircuitBreaker({
        name: service.name,
        failureThreshold:
          service.breaker?.failureThreshold ?? env.BREAKER_FAILURE_THRESHOLD,
        resetTimeoutMs:
          service.breaker?.resetTimeoutMs ?? env.BREAKER_RESET_TIMEOUT_MS,
        onTransition: (transition) => {
          logger.warn(
            {
              event: PROXY_EVENTS.breakerTransition,
              service: transition.name,
              from: transition.from,
              to: transition.to,
              consecutiveFailures: transition.consecutiveFailures,
            },
            "circuit breaker state changed",
          );
        },
      }),
  );
}

type ProxyRequestFacts = {
  readonly user: VerifiedPrincipal | null;
  readonly requestId: string;
  readonly ip: string;
  readonly headers: IncomingHttpHeaders;
};

function buildUpstreamHeaders(
  request: ProxyRequestFacts,
  headers: IncomingHttpHeaders,
): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = { ...headers };

  for (const header of HOP_BY_HOP_HEADERS) {
    Reflect.deleteProperty(forwarded, header);
  }

  for (const header of IDENTITY_HEADERS) {
    Reflect.deleteProperty(forwarded, header);
  }

  if (request.user !== null) {
    Object.assign(forwarded, identityHeadersFor(request.user));
  }

  forwarded[REQUEST_ID_HEADER] = request.requestId;
  forwarded[FORWARDED_FOR_HEADER] = request.ip;

  const traceparent = request.headers[TRACEPARENT_HEADER];
  if (typeof traceparent === "string") {
    forwarded[TRACEPARENT_HEADER] = traceparent;
  }

  const tracestate = request.headers[TRACESTATE_HEADER];
  if (typeof tracestate === "string") {
    forwarded[TRACESTATE_HEADER] = tracestate;
  }

  return forwarded;
}

async function registerService(
  app: FastifyInstance,
  service: ActiveService,
  prefix: string,
): Promise<void> {
  const breaker = breakerFor(service);
  const timeoutMs = service.timeoutMs ?? env.UPSTREAM_TIMEOUT_MS;

  await app.register(httpProxy, {
    upstream: service.upstream,
    prefix,
    rewritePrefix: prefix,
    httpMethods: [...PROXIED_METHODS],
    retryMethods: [...IDEMPOTENT_METHODS],
    proxyPayloads: false,
    maxRetriesOn503: 0,
    undici: {
      connectTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    },

    preHandler: (request, _reply, done) => {
      request.upstreamService = service.name;

      if (!breaker.allowRequest()) {
        logger.warn(
          {
            event: PROXY_EVENTS.breakerRejected,
            service: service.name,
            state: breaker.state,
          },
          "circuit breaker open; request shed without contacting the upstream",
        );

        done(
          upstreamUnavailableError({
            service: service.name,
            reason: `breaker_${breaker.state}`,
            retryAfterSeconds: breaker.retryAfterSeconds,
          }),
        );
        return;
      }

      done();
    },

    replyOptions: {
      rewriteRequestHeaders: (request, headers) =>
        buildUpstreamHeaders(request, headers),
      onResponse: (_request, reply, res) => {
        breaker.recordUpstreamStatus(res.statusCode);
        void reply.send(res.stream);
      },

      onError: (reply, { error }) => {
        breaker.recordFailure();

        logger.error(
          {
            event: PROXY_EVENTS.upstreamError,
            service: service.name,
            err: error.message,
            breakerState: breaker.state,
          },
          "upstream request failed",
        );

        const retryAfter =
          breaker.state === BREAKER_STATES.open
            ? breaker.retryAfterSeconds
            : Math.ceil(env.BREAKER_RESET_TIMEOUT_MS / 1000);

        void reply.send(
          upstreamUnavailableError({
            service: service.name,
            reason: "upstream_unreachable",
            retryAfterSeconds: retryAfter,
            cause: error,
          }),
        );
      },
    },
  });
}

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const services = activeServices();

  if (services.length === 0) {
    logger.warn(
      { event: "no_active_upstreams" },
      "no upstream service URL is configured: the gateway will serve only its own routes",
    );
    return;
  }

  for (const service of services) {
    for (const prefix of service.prefixes) {
      await registerService(app, service, prefix);

      logger.info(
        {
          event: "upstream_registered",
          service: service.name,
          codename: service.codename,
          prefix,
          upstream: service.upstream,
        },
        "upstream registered",
      );
    }
  }
}
