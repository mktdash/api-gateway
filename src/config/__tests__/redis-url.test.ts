import { describe, expect, it } from "vitest";
import {
  composeRedactedRedisUrl,
  type RedisConnectionParts,
  toRedisAuthOptions,
  toRedisTlsOptions,
} from "../redis-url.ts";

function parts(
  overrides: Partial<RedisConnectionParts> = {},
): RedisConnectionParts {
  return {
    host: "127.0.0.1",
    port: 6380,
    username: "",
    password: "",
    db: 0,
    tls: "disable",
    ...overrides,
  };
}

describe("auth options follow the ACL shape Redis actually accepts", () => {
  it("sends nothing when neither username nor password is set", () => {
    expect(toRedisAuthOptions(parts())).toEqual({});
  });

  it("sends password-only when no username is configured, never an empty username", () => {
    const auth = toRedisAuthOptions(parts({ password: "s3cret" }));

    expect(auth).toEqual({ password: "s3cret" });
    expect(auth).not.toHaveProperty("username");
  });

  it("sends both when an ACL username is configured", () => {
    expect(
      toRedisAuthOptions(parts({ username: "gateway", password: "s3cret" })),
    ).toEqual({ username: "gateway", password: "s3cret" });
  });
});

describe("TLS options", () => {
  it("is disabled outright rather than passed an empty object", () => {
    expect(toRedisTlsOptions("disable")).toBe(false);
  });

  it("verifies the chain and floors the protocol version", () => {
    expect(toRedisTlsOptions("verify-full")).toEqual({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
  });
});

describe("the redacted target is safe to log", () => {
  it("never contains the password", () => {
    const url = composeRedactedRedisUrl(parts({ password: "s3cret" }));

    expect(url).not.toContain("s3cret");
    expect(url).toBe("redis://:[redacted]@127.0.0.1:6380/0");
  });

  it("omits the user-info section entirely when there is no credential", () => {
    expect(composeRedactedRedisUrl(parts())).toBe("redis://127.0.0.1:6380/0");
  });

  it("keeps the username visible so a wrong ACL user is diagnosable", () => {
    expect(
      composeRedactedRedisUrl(parts({ username: "gateway", password: "s3" })),
    ).toBe("redis://gateway:[redacted]@127.0.0.1:6380/0");
  });

  it("switches scheme to rediss under TLS", () => {
    expect(composeRedactedRedisUrl(parts({ tls: "verify-full" }))).toBe(
      "rediss://127.0.0.1:6380/0",
    );
  });

  it("brackets an IPv6 host so the port stays parseable", () => {
    expect(composeRedactedRedisUrl(parts({ host: "::1" }))).toBe(
      "redis://[::1]:6380/0",
    );
  });

  it("does not double-bracket a host that is already bracketed", () => {
    expect(composeRedactedRedisUrl(parts({ host: "[::1]" }))).toBe(
      "redis://[::1]:6380/0",
    );
  });

  it("carries the db index, because it is part of the pv contract with identity-service", () => {
    expect(composeRedactedRedisUrl(parts({ db: 3 }))).toBe(
      "redis://127.0.0.1:6380/3",
    );
  });
});
