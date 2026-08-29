import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "x-request-id";
export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

const TRACEPARENT_PATTERN =
  /^(?<version>[0-9a-f]{2})-(?<traceId>[0-9a-f]{32})-(?<spanId>[0-9a-f]{16})-(?<flags>[0-9a-f]{2})$/u;

export type TraceParent = {
  readonly traceId: string;
  readonly spanId: string;
};

export type RequestCorrelation = {
  readonly requestId: string;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  userId?: string | undefined;
  organizationId?: string | undefined;
  workspaceId?: string | undefined;
  sessionId?: string | undefined;
};

const storage = new AsyncLocalStorage<RequestCorrelation>();

export function getCorrelation(): RequestCorrelation | undefined {
  return storage.getStore();
}

export function runWithCorrelation<T>(
  correlation: RequestCorrelation,
  callback: () => T,
): T {
  return storage.run(correlation, callback);
}

export function setCorrelationPrincipal(principal: {
  readonly userId?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly sessionId?: string | undefined;
}): void {
  const correlation = storage.getStore();
  if (correlation === undefined) {
    return;
  }

  if (principal.userId !== undefined) {
    correlation.userId = principal.userId;
  }
  if (principal.organizationId !== undefined) {
    correlation.organizationId = principal.organizationId;
  }
  if (principal.workspaceId !== undefined) {
    correlation.workspaceId = principal.workspaceId;
  }
  if (principal.sessionId !== undefined) {
    correlation.sessionId = principal.sessionId;
  }
}

export function firstHeaderValue(value: unknown): string | undefined {
  const candidate: unknown = Array.isArray(value)
    ? (value as readonly unknown[])[0]
    : value;
  return typeof candidate === "string" ? candidate : undefined;
}

export function normalizeRequestId(value: unknown): string | undefined {
  const candidate = firstHeaderValue(value);
  if (candidate === undefined) {
    return undefined;
  }

  const trimmed = candidate.trim();
  return REQUEST_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function createRequestId(): string {
  return randomUUID();
}

export function parseTraceparent(value: unknown): TraceParent | undefined {
  const candidate = firstHeaderValue(value);
  if (candidate === undefined) {
    return undefined;
  }

  const groups = TRACEPARENT_PATTERN.exec(candidate.trim())?.groups;
  if (groups === undefined) {
    return undefined;
  }

  const traceId = groups.traceId ?? "";
  const spanId = groups.spanId ?? "";

  if (/^0+$/u.test(traceId) || /^0+$/u.test(spanId)) {
    return undefined;
  }

  return { traceId, spanId };
}

export function logCorrelation(): Record<string, string> {
  const correlation = storage.getStore();
  if (correlation === undefined) {
    return {};
  }

  const fields: Record<string, string> = { requestId: correlation.requestId };

  if (correlation.traceId !== undefined) {
    fields.trace_id = correlation.traceId;
  }
  if (correlation.spanId !== undefined) {
    fields.span_id = correlation.spanId;
  }
  if (correlation.userId !== undefined) {
    fields.userId = correlation.userId;
  }
  if (correlation.organizationId !== undefined) {
    fields.organizationId = correlation.organizationId;
  }
  if (correlation.workspaceId !== undefined) {
    fields.workspaceId = correlation.workspaceId;
  }
  if (correlation.sessionId !== undefined) {
    fields.sessionId = correlation.sessionId;
  }

  return fields;
}
