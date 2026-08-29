import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type GatewayApp } from "../../src/app.ts";
import { IDENTITY_HEADERS } from "../../src/lib/identity-headers.ts";
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

describe("client-supplied identity headers", () => {
  it("never reaches the upstream on a PUBLIC route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: {
        "content-type": "application/json",
        "x-user-id": "victim-user-id",
        "x-org-id": "victim-org-id",
        "x-workspace-id": "victim-workspace-id",
        "x-actor-user-id": "victim-actor",
        "x-permission-version": "999",
      },
      payload: { email: "someone@example.com" },
    });

    expect(response.statusCode).toBe(202);

    const forwarded = upstream.lastRequest;
    expect(forwarded).toBeDefined();

    for (const header of IDENTITY_HEADERS) {
      expect(forwarded?.headers[header]).toBeUndefined();
    }
  });

  it("is replaced by the token's claims on an authenticated route", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/anything",
      headers: {
        authorization: await authHeader({
          userId: "real-user",
          organizationId: "real-org",
          workspaceId: "real-workspace",
          sessionId: "real-session",
          permissionVersion: 7,
        }),
        "x-user-id": "attacker-supplied",
        "x-org-id": "attacker-org",
      },
    });

    expect(response.statusCode).toBe(202);

    const forwarded = upstream.lastRequest;
    expect(forwarded?.headers["x-user-id"]).toBe("real-user");
    expect(forwarded?.headers["x-org-id"]).toBe("real-org");
    expect(forwarded?.headers["x-workspace-id"]).toBe("real-workspace");
    expect(forwarded?.headers["x-session-id"]).toBe("real-session");
    expect(forwarded?.headers["x-permission-version"]).toBe("7");
  });

  it("omits x-workspace-id entirely for an org-scoped token rather than faking it", async () => {
    await app.inject({
      method: "GET",
      url: "/v1/auth/anything",
      headers: { authorization: await authHeader({ workspaceId: undefined }) },
    });

    expect(upstream.lastRequest?.headers).not.toHaveProperty("x-workspace-id");
  });

  it("never forges x-membership-id or x-role-id, which identity-service does not mint", async () => {
    await app.inject({
      method: "GET",
      url: "/v1/auth/anything",
      headers: { authorization: await authHeader() },
    });

    expect(upstream.lastRequest?.headers).not.toHaveProperty("x-membership-id");
    expect(upstream.lastRequest?.headers).not.toHaveProperty("x-role-id");
  });

  it("forwards the impersonation actor as its own header", async () => {
    await app.inject({
      method: "GET",
      url: "/v1/auth/anything",
      headers: {
        authorization: await authHeader({
          userId: "impersonated-user",
          actorUserId: "super-admin",
        }),
      },
    });

    expect(upstream.lastRequest?.headers["x-user-id"]).toBe(
      "impersonated-user",
    );
    expect(upstream.lastRequest?.headers["x-actor-user-id"]).toBe(
      "super-admin",
    );
  });
});

describe("X-Forwarded-For with trustProxy=false", () => {
  it("overwrites a spoofed chain rather than appending to it", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "6.6.6.6, 203.0.113.9",
      },
      remoteAddress: "10.0.0.1",
      payload: {},
    });

    expect(upstream.lastRequest?.headers["x-forwarded-for"]).toBe("10.0.0.1");
    expect(upstream.lastRequest?.headers["x-forwarded-for"]).not.toContain(
      "6.6.6.6",
    );
  });
});
