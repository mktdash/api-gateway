import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import fp from "fastify-plugin";
import { isProduction } from "#config/env";
import { requestPathname } from "#lib/request-path";
import {
  ERROR_CODES,
  errorTypeUri,
  isGatewayError,
  type ErrorCode,
  type ProblemDetails,
} from "#lib/errors";
import { logger, securityLogger } from "#lib/logger";

const PROBLEM_JSON = "application/problem+json";

type ProblemInput = {
  readonly status: number;
  readonly code: ErrorCode;
  readonly title: string;
  readonly detail: string;
};

function problem(request: FastifyRequest, input: ProblemInput): ProblemDetails {
  return {
    type: errorTypeUri(input.code),
    title: input.title,
    status: input.status,
    code: input.code,
    detail: input.detail,
    instance: requestPathname(request.url),
    requestId: request.requestId,
  };
}

const STATUS_MAP: ReadonlyMap<
  number,
  { code: ErrorCode; title: string; detail: string }
> = new Map([
  [
    400,
    {
      code: ERROR_CODES.malformedRequest,
      title: "Malformed request",
      detail: "The request could not be parsed.",
    },
  ],
  [
    404,
    {
      code: ERROR_CODES.notFound,
      title: "Not found",
      detail: "No route at this address is served by the gateway.",
    },
  ],
  [
    405,
    {
      code: ERROR_CODES.methodNotAllowed,
      title: "Method not allowed",
      detail: "This method is not supported for this resource.",
    },
  ],
  [
    413,
    {
      code: ERROR_CODES.payloadTooLarge,
      title: "Payload too large",
      detail: "The request body exceeded the maximum accepted size.",
    },
  ],
  [
    415,
    {
      code: ERROR_CODES.unsupportedMediaType,
      title: "Unsupported media type",
      detail: "This endpoint accepts application/json.",
    },
  ],
  [
    429,
    {
      code: ERROR_CODES.rateLimited,
      title: "Too many requests",
      detail:
        "Rate limit exceeded. Retry after the interval in the Retry-After header.",
    },
  ],
  [
    503,
    {
      code: ERROR_CODES.serviceUnavailable,
      title: "Service unavailable",
      detail: "The gateway is shedding load. Try again shortly.",
    },
  ],
]);

function isSecurityEvent(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler((request, reply) => {
    logger.info(
      {
        event: "route_not_found",
        method: request.method,
        path: requestPathname(request.url),
        requestId: request.requestId,
      },
      "no gateway route",
    );

    void reply
      .code(404)
      .type(PROBLEM_JSON)
      .send(
        problem(request, {
          status: 404,
          code: ERROR_CODES.notFound,
          title: "Not found",
          detail: "No route at this address is served by the gateway.",
        }),
      );
  });

  app.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      if (isGatewayError(error)) {
        for (const [header, value] of Object.entries(error.headers)) {
          void reply.header(header, value);
        }

        const log = isSecurityEvent(error.status)
          ? securityLogger
          : request.log;
        log[error.status >= 500 ? "error" : "warn"](
          {
            event: error.code,
            status: error.status,
            method: request.method,
            path: requestPathname(request.url),
            ...error.logContext,
          },
          error.title,
        );

        void reply
          .code(error.status)
          .type(PROBLEM_JSON)
          .send(
            error.toProblemDetails(
              requestPathname(request.url),
              request.requestId,
            ),
          );
        return;
      }

      const status =
        typeof error.statusCode === "number" ? error.statusCode : 500;
      const mapped = STATUS_MAP.get(status);

      if (mapped !== undefined && status < 500) {
        request.log.warn(
          { event: mapped.code, status, method: request.method },
          mapped.title,
        );

        void reply
          .code(status)
          .type(PROBLEM_JSON)
          .send(problem(request, { status, ...mapped }));
        return;
      }

      if (status === 503) {
        const shed = STATUS_MAP.get(503);
        void reply.header("retry-after", "10");
        request.log.warn(
          { event: ERROR_CODES.serviceUnavailable, status },
          "load shed",
        );
        void reply
          .code(503)
          .type(PROBLEM_JSON)
          .send(
            problem(request, {
              status: 503,
              code: shed?.code ?? ERROR_CODES.serviceUnavailable,
              title: shed?.title ?? "Service unavailable",
              detail: shed?.detail ?? "Try again shortly.",
            }),
          );
        return;
      }

      request.log.error(
        {
          err: error,
          event: ERROR_CODES.internalError,
          status,
          method: request.method,
          path: requestPathname(request.url),
        },
        "unhandled error",
      );

      void reply
        .code(500)
        .type(PROBLEM_JSON)
        .send(
          problem(request, {
            status: 500,
            code: ERROR_CODES.internalError,
            title: "Internal server error",
            detail: isProduction
              ? "Something went wrong. Quote the requestId when reporting this."
              : `Something went wrong (${error.name}). Check the gateway log for requestId ${request.requestId}.`,
          }),
        );
    },
  );
}

export default fp(errorHandlerPlugin, {
  name: "error-handler",
  fastify: "5.x",
});
