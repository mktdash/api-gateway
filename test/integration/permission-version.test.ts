import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type GatewayApp } from "../../src/app.ts";
import { PV_OUTCOMES } from "../../src/lib/permission-version.ts";
import { FakePermissionVersionStore } from "../helpers/permission-version-store.ts";
import { authHeader } from "../helpers/tokens.ts";
import { upstream } from "../setup/environment.ts";

const USER = "33333333-3333-4333-8333-333333333333";
const ORG = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "55555555-5555-4555-8555-555555555555";

const SUBJECT = {
  userId: USER,
  organizationId: ORG,
  workspaceId: WORKSPACE,
} as const;

const store = new FakePermissionVersionStore();

let monitorApp: GatewayApp;
let enforceApp: GatewayApp;

beforeAll(async () => {
  monitorApp = await buildApp({
    permissionVersionStore: store,
    permissionVersionMode: "monitor",
  });
  enforceApp = await buildApp({
    permissionVersionStore: store,
    permissionVersionMode: "enforce",
  });
});

afterAll(async () => {
  await monitorApp.close();
  await enforceApp.close();
});

afterEach(() => {
  store.reset();
  upstream.reset();
});

async function get(
  app: GatewayApp,
  options: { permissionVersion?: number; workspaceId?: string } = {},
) {
  return app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: {
      authorization: await authHeader({
        userId: USER,
        organizationId: ORG,
        workspaceId: options.workspaceId ?? WORKSPACE,
        permissionVersion: options.permissionVersion ?? 3,
      }),
    },
  });
}

function problem(response: { payload: string }): Record<string, unknown> {
  return JSON.parse(response.payload) as Record<string, unknown>;
}

describe("a token whose permissions are current", () => {
  it("is proxied upstream", async () => {
    store.publish(SUBJECT, 3);

    const response = await get(monitorApp, { permissionVersion: 3 });

    expect(response.statusCode).toBe(202);
    expect(upstream.lastRequest?.headers["x-user-id"]).toBe(USER);
  });

  it("actually performs the lookup, against the published namespace", async () => {
    store.publish(SUBJECT, 3);

    await get(monitorApp, { permissionVersion: 3 });

    expect(store.reads).toHaveLength(1);
    expect(store.reads[0]).toBe(`identity:pv:w:${ORG}:${WORKSPACE}:${USER}`);
  });
});

describe("a token whose permissions have changed", () => {
  it("is REJECTED on the very next request, not when the token expires", async () => {
    store.publish(SUBJECT, 4);

    const response = await get(monitorApp, { permissionVersion: 3 });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_stale");
  });

  it("is rejected under enforce as well as monitor", async () => {
    store.publish(SUBJECT, 4);

    const response = await get(enforceApp, { permissionVersion: 3 });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_stale");
  });

  it("rejects a demoted user whose version moved backwards", async () => {
    store.publish(SUBJECT, 2);

    const response = await get(monitorApp, { permissionVersion: 3 });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_stale");
  });

  it("never reaches the upstream", async () => {
    store.publish(SUBJECT, 9);

    await get(monitorApp, { permissionVersion: 3 });

    expect(upstream.requests).toHaveLength(0);
  });

  it("does not leak the published version or the key to the caller", async () => {
    store.publish(SUBJECT, 4);

    const response = await get(monitorApp, { permissionVersion: 3 });
    const body = problem(response);

    expect(body.detail).toBe(
      "Permissions changed since this token was issued.",
    );
    expect(response.payload).not.toContain("identity:pv:");
    expect(JSON.stringify(body)).not.toContain('"publishedVersion"');
  });

  it("answers 401 rather than 403, so the client refreshes", async () => {
    store.publish(SUBJECT, 4);

    const response = await get(monitorApp, { permissionVersion: 3 });

    expect(response.statusCode).toBe(401);
  });
});

describe("a subject with nothing published", () => {
  it("is ALLOWED in monitor mode — the platform's state today", async () => {
    const response = await get(monitorApp, { permissionVersion: 3 });

    expect(response.statusCode).toBe(202);
  });

  it("is REJECTED in enforce mode — the state once publishing is live", async () => {
    const response = await get(enforceApp, { permissionVersion: 3 });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_stale");
  });
});

describe("Redis unavailable", () => {
  it("fails OPEN, even under enforce", async () => {
    store.failWith(new Error("ECONNREFUSED"));

    const response = await get(enforceApp, { permissionVersion: 3 });

    expect(response.statusCode).toBe(202);
  });

  it("still forwards the verified identity upstream while degraded", async () => {
    store.failWith(new Error("ECONNREFUSED"));

    await get(monitorApp, { permissionVersion: 3 });

    expect(upstream.lastRequest?.headers["x-user-id"]).toBe(USER);
  });

  it("does not put the Redis key or the error in the response", async () => {
    store.failWith(new Error("ECONNREFUSED"));

    const response = await get(monitorApp, { permissionVersion: 3 });

    expect(response.payload).not.toContain("ECONNREFUSED");
    expect(response.payload).not.toContain("identity:pv:");
  });
});

describe("a broken publisher", () => {
  it.each([["not-a-number"], [""], ["4.5"], ["-1"]])(
    "treats a published value of %j as degraded, not as a stale token",
    async (value) => {
      store.publish(SUBJECT, value);

      const response = await get(monitorApp, { permissionVersion: 3 });

      expect(response.statusCode).toBe(202);
    },
  );
});

describe("scope", () => {
  it("does not run the check on a public route", async () => {
    const response = await monitorApp.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { "content-type": "application/json" },
      payload: {},
    });

    expect(response.statusCode).toBe(202);
    expect(store.reads).toHaveLength(0);
  });

  it("does not run the check on Argus's own probe routes", async () => {
    await monitorApp.inject({ method: "GET", url: "/health" });

    expect(store.reads).toHaveLength(0);
  });

  it("keys an org-scoped token without a workspace separately", async () => {
    store.publish(SUBJECT, 3);

    const response = await enforceApp.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: {
        authorization: await authHeader({
          userId: USER,
          organizationId: ORG,
          permissionVersion: 3,
        }),
      },
    });

    expect(response.statusCode).toBe(401);
    expect(store.reads[0]).toBe(`identity:pv:o:${ORG}:${USER}`);
  });
});

describe("the check cannot be influenced by the client", () => {
  it("ignores a spoofed x-permission-version header", async () => {
    store.publish(SUBJECT, 4);

    const response = await monitorApp.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: {
        authorization: await authHeader({
          userId: USER,
          organizationId: ORG,
          workspaceId: WORKSPACE,
          permissionVersion: 3,
        }),
        "x-permission-version": "4",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe("token_stale");
  });

  it("ignores a spoofed x-user-id when building the key", async () => {
    store.publish(SUBJECT, 4);

    const response = await monitorApp.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: {
        authorization: await authHeader({
          userId: USER,
          organizationId: ORG,
          workspaceId: WORKSPACE,
          permissionVersion: 3,
        }),
        "x-user-id": "99999999-9999-4999-8999-999999999999",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(store.reads[0]).toBe(`identity:pv:w:${ORG}:${WORKSPACE}:${USER}`);
  });
});

describe("observability", () => {
  it("reports on /status that comparison is live once a value is read", async () => {
    store.publish(SUBJECT, 3);
    await get(monitorApp, { permissionVersion: 3 });

    const response = await monitorApp.inject({ method: "GET", url: "/status" });
    const body = JSON.parse(response.payload) as {
      permissionVersion: {
        namespace: string;
        comparing: boolean;
        outcomes: Record<string, number>;
      };
    };

    expect(body.permissionVersion.namespace).toBe("identity:pv:");
    expect(body.permissionVersion.comparing).toBe(true);
    expect(body.permissionVersion.outcomes[PV_OUTCOMES.match]).toBeGreaterThan(
      0,
    );
  });
});
