export const GATEWAY_ERROR_CODES = {
  tokenMissing: "token_missing",
  tokenInvalid: "token_invalid",
  tokenWrongType: "token_wrong_type",
  tokenStale: "token_stale",
  upstreamUnavailable: "upstream_unavailable",
  rateLimited: "rate_limited",
} as const;

export const PLATFORM_ERROR_CODES = {
  malformedRequest: "malformed_request",
  unsupportedMediaType: "unsupported_media_type",
  payloadTooLarge: "payload_too_large",
  notFound: "not_found",
  methodNotAllowed: "method_not_allowed",
  internalError: "internal_error",
  serviceUnavailable: "service_unavailable",
} as const;

export const ERROR_CODES = {
  ...GATEWAY_ERROR_CODES,
  ...PLATFORM_ERROR_CODES,
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ERROR_TYPE_BASE_URL = "https://errors.mktdash.io";

export function errorTypeUri(code: ErrorCode): string {
  return `${ERROR_TYPE_BASE_URL}/${code.replaceAll("_", "-")}`;
}

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  instance?: string;
  requestId?: string;
};

export type GatewayErrorOptions = {
  readonly status: number;
  readonly code: ErrorCode;
  readonly title: string;
  readonly detail: string;
  readonly cause?: unknown;
  readonly logContext?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
};

export class GatewayError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly title: string;
  readonly detail: string;
  readonly logContext: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;

  constructor(options: GatewayErrorOptions) {
    super(
      options.detail,
      options.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.detail = options.detail;
    this.logContext = options.logContext ?? {};
    this.headers = options.headers ?? {};
  }

  toProblemDetails(instance?: string, requestId?: string): ProblemDetails {
    const problem: ProblemDetails = {
      type: errorTypeUri(this.code),
      title: this.title,
      status: this.status,
      code: this.code,
      detail: this.detail,
    };

    if (instance !== undefined) {
      problem.instance = instance;
    }

    if (requestId !== undefined) {
      problem.requestId = requestId;
    }

    return problem;
  }
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError;
}

export function tokenMissingError(): GatewayError {
  return new GatewayError({
    status: 401,
    code: ERROR_CODES.tokenMissing,
    title: "Authentication required",
    detail: "This endpoint requires a bearer access token.",
  });
}

export function tokenInvalidError(
  reason: string,
  cause?: unknown,
): GatewayError {
  return new GatewayError({
    status: 401,
    code: ERROR_CODES.tokenInvalid,
    title: "Invalid token",
    detail: "The access token could not be verified.",
    ...(cause === undefined ? {} : { cause }),
    logContext: { reason },
  });
}

export function tokenWrongTypeError(actualType: string): GatewayError {
  return new GatewayError({
    status: 401,
    code: ERROR_CODES.tokenWrongType,
    title: "Wrong token type",
    detail: "This credential is not an access token.",
    logContext: { tokenType: actualType },
  });
}

export function tokenStaleError(context: {
  readonly tokenVersion: number;
  readonly publishedVersion: number;
}): GatewayError {
  return new GatewayError({
    status: 401,
    code: ERROR_CODES.tokenStale,
    title: "Permissions changed",
    detail: "Permissions changed since this token was issued.",
    logContext: { ...context },
  });
}

export function upstreamUnavailableError(context: {
  readonly service: string;
  readonly reason: string;
  readonly retryAfterSeconds: number;
  readonly cause?: unknown;
}): GatewayError {
  return new GatewayError({
    status: 503,
    code: ERROR_CODES.upstreamUnavailable,
    title: "Service unavailable",
    detail:
      "The service behind this endpoint is not responding. Try again shortly.",
    ...(context.cause === undefined ? {} : { cause: context.cause }),
    headers: { "retry-after": String(context.retryAfterSeconds) },
    logContext: { service: context.service, reason: context.reason },
  });
}

export function rateLimitedError(retryAfterSeconds: number): GatewayError {
  return new GatewayError({
    status: 429,
    code: ERROR_CODES.rateLimited,
    title: "Too many requests",
    detail:
      "Rate limit exceeded. Retry after the interval in the Retry-After header.",
    headers: { "retry-after": String(retryAfterSeconds) },
  });
}

export function serviceUnavailableError(
  retryAfterSeconds: number,
  reason: string,
): GatewayError {
  return new GatewayError({
    status: 503,
    code: ERROR_CODES.serviceUnavailable,
    title: "Service unavailable",
    detail: "The gateway is shedding load. Try again shortly.",
    headers: { "retry-after": String(retryAfterSeconds) },
    logContext: { reason },
  });
}
