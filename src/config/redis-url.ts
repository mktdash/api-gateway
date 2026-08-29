import type { ConnectionOptions } from "node:tls";

export const REDIS_TLS_MODES = ["disable", "verify-full"] as const;

export type RedisTlsMode = (typeof REDIS_TLS_MODES)[number];

export type RedisConnectionParts = {
  host: string;
  port: number;
  username: string;
  password: string;
  db: number;
  tls: RedisTlsMode;
};

export function toRedisTlsOptions(
  mode: RedisTlsMode,
): false | ConnectionOptions {
  if (mode === "disable") {
    return false;
  }

  return { rejectUnauthorized: true, minVersion: "TLSv1.2" };
}

export type RedisAuthOptions = {
  username?: string;
  password?: string;
};

export function toRedisAuthOptions(
  parts: RedisConnectionParts,
): RedisAuthOptions {
  if (parts.username) {
    return { username: parts.username, password: parts.password };
  }

  if (parts.password) {
    return { password: parts.password };
  }

  return {};
}

function formatUrlHost(host: string): string {
  if (!host.includes(":") || host.startsWith("[")) {
    return host;
  }

  return `[${host}]`;
}

function buildUserInfo(parts: RedisConnectionParts): string {
  if (parts.username) {
    return `${encodeURIComponent(parts.username)}:[redacted]@`;
  }

  if (parts.password) {
    return ":[redacted]@";
  }

  return "";
}

export function composeRedactedRedisUrl(parts: RedisConnectionParts): string {
  const scheme = parts.tls === "disable" ? "redis" : "rediss";
  const authority = `${formatUrlHost(parts.host)}:${String(parts.port)}`;
  return `${scheme}://${buildUserInfo(parts)}${authority}/${String(parts.db)}`;
}
