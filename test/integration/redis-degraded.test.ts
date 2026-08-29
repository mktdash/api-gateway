import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type GatewayApp } from "../../src/app.ts";
import { isRedisConfigured } from "../../src/lib/redis-client.ts";
import { authHeader } from "../helpers/tokens.ts";
import { upstream } from "../setup/environment.ts";

let app: GatewayApp;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  upstream.reset();
});

describe("with Redis unconfigured", () => {
  it("is the state this suite actually runs in", () => {
    expect(isRedisConfigured()).toBe(false);
  });

  it("still boots and serves liveness", () => {
    expect(app).toBeDefined();
  });

  it("answers /health without touching any dependency", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({ status: "ok" });
  });

  it("reports itself READY, because both Redis uses are fail-open", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({
      status: "ready",
      checks: { redis: { configured: false, ok: false } },
    });
  });

  it("says so on /status rather than leaving it to be inferred", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = JSON.parse(response.payload) as {
      permissionVersion: {
        comparing: boolean;
        outcomes: Record<string, number>;
      };
    };

    expect(body.permissionVersion.comparing).toBe(false);
  });
});

describe("authenticated traffic while Redis is unavailable", () => {
  it("still succeeds — the permission check fails OPEN", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: await authHeader() },
    });

    expect(response.statusCode).toBe(202);
  });

  it("records the degraded outcome so it is visible in an incident review", async () => {
    await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: await authHeader() },
    });

    const response = await app.inject({ method: "GET", url: "/status" });
    const body = JSON.parse(response.payload) as {
      permissionVersion: { outcomes: Record<string, number> };
    };

    expect(body.permissionVersion.outcomes["redis-down"]).toBeGreaterThan(0);
  });

  it("still verifies the JWT — fail-open covers freshness, never authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: "Bearer not-a-real-token" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("still rejects a missing token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload)).toMatchObject({
      code: "token_missing",
    });
  });

  it("still strips client-supplied identity headers", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: {
        "content-type": "application/json",
        "x-user-id": "99999999-9999-4999-8999-999999999999",
      },
      payload: {},
    });

    expect(upstream.lastRequest?.headers["x-user-id"]).toBeUndefined();
  });
});

describe("rate limiting while Redis is unavailable", () => {
  it("keeps enforcing, on per-instance in-memory counters", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: await authHeader() },
    });

    expect(response.headers["x-ratelimit-limit"]).toBeDefined();
    expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
  });

  it("does not fail the request when the limiter cannot reach a store", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
  });
});

describe("what a degraded gateway must never leak", () => {
  it("does not put the bearer token in any response body", async () => {
    const token = await authHeader();

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: token },
    });

    expect(response.payload).not.toContain(token.replace("Bearer ", ""));
  });

  it("does not expose the Redis key namespace on an error path", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: "Bearer nonsense" },
    });

    expect(response.payload).not.toContain("identity:pv:");
    expect(response.payload).not.toContain("REDIS");
  });
});
