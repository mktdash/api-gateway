import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type GatewayApp } from "../../src/app.ts";
import { SignJWT } from "jose";
import {
  authHeader,
  mintTestToken,
  TEST_AUDIENCE,
  TEST_ISSUER,
} from "../helpers/tokens.ts";
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

function problem(response: { payload: string }): Record<string, unknown> {
  return JSON.parse(response.payload) as Record<string, unknown>;
}

describe("public path matching", () => {
  it.each([
    ["/v1/auth/register", "POST"],
    ["/v1/auth/verify-email", "POST"],
    ["/v1/auth/verify-email/resend", "POST"],
  ])("treats %s as public with no token", async (url, method) => {
    const response = await app.inject({
      method: method as "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
  });

  it("still treats a public path as public when a query string is present", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register?utm_source=email&next=%2Fwelcome",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
  });

  it("does not leak the allowlist to a neighbouring path", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register-admin",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it("requires a token for a method the allowlist does not name", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/register",
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("token rejection", () => {
  it("rejects a missing token with token_missing", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/auth/me" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain(
      "application/problem+json",
    );
    expect(problem(response).code).toBe("token_missing");
  });

  it("rejects a malformed token with token_invalid", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: "Bearer not-a-jwt" },
    });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_invalid");
  });

  it("rejects an expired token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: await authHeader({ expiresInSeconds: -3600 }) },
    });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_invalid");
  });

  it("rejects an mfa_pending token even though the signature is valid", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: await authHeader({ type: "mfa_pending" }) },
    });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_wrong_type");
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects a refresh token presented as a bearer credential", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: await authHeader({ type: "refresh" }) },
    });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_wrong_type");
  });

  it("rejects a signature from a key that is not published in the JWKS", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: await authHeader({ useForeignKey: true }) },
    });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_invalid");
  });

  it("rejects an unsigned (alg: none) token", async () => {
    const unsigned = `${Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "attacker", typ: "access" }),
    ).toString("base64url")}.`;

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${unsigned}` },
    });

    expect(response.statusCode).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects an HMAC-signed token, even though the signature is internally valid", async () => {
    const forged = await new SignJWT({
      typ: "access",
      sid: "11111111-1111-4111-8111-111111111111",
      org: "22222222-2222-4222-8222-222222222222",
      pv: 1,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setSubject("attacker")
      .setJti("44444444-4444-4444-8444-444444444444")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("a-secret-the-attacker-controls"));

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_invalid");
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects a token minted for a different audience", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: {
        authorization: await authHeader({ audience: "some-other-app" }),
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a token from a different issuer", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: {
        authorization: await authHeader({ issuer: "https://evil.example" }),
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("never returns 403 — Argus makes no authorization decisions", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/v1/auth/me" }),
      app.inject({
        method: "GET",
        url: "/v1/auth/me",
        headers: { authorization: "Bearer rubbish" },
      }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).not.toBe(403);
    }
  });

  it("never echoes the token back in the error body", async () => {
    const token = await mintTestToken({ type: "mfa_pending" });
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.payload).not.toContain(token);
  });
});

describe("valid tokens", () => {
  it("passes a well-formed access token through to the upstream", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: await authHeader() },
    });

    expect(response.statusCode).toBe(202);
    expect(upstream.requests).toHaveLength(1);
  });

  it("does not forward the Authorization header's own credentials as identity", async () => {
    await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: await authHeader({ userId: "verified-user" }) },
    });

    expect(upstream.lastRequest?.headers["x-user-id"]).toBe("verified-user");
  });
});

describe("health and openapi stay public", () => {
  it.each(["/health", "/ready", "/status", "/openapi.json"])(
    "%s answers without a token",
    async (url) => {
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBeLessThan(400);
    },
  );
});
