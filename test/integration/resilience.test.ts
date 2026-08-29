import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { buildApp, type GatewayApp } from "../../src/app.ts";
import { resetBreakers } from "../../src/lib/circuit-breaker.ts";
import { upstream } from "../setup/environment.ts";

let app: GatewayApp;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  resetBreakers();
});

afterEach(() => {
  upstream.reset();
});

const publicRegister = {
  method: "POST" as const,
  url: "/v1/auth/register",
  headers: { "content-type": "application/json" },
  payload: {},
};

describe("upstream responses are forwarded untouched", () => {
  it("preserves an upstream 4xx status, body and content type", async () => {
    upstream.behaviour.status = 409;
    upstream.behaviour.contentType = "application/problem+json";
    upstream.behaviour.body = JSON.stringify({
      type: "https://errors.mktdash.io/email-already-registered",
      title: "Email already registered",
      status: 409,
      code: "email_already_registered",
      detail: "An account already exists for that email address.",
    });

    const response = await app.inject(publicRegister);

    expect(response.statusCode).toBe(409);
    expect(response.headers["content-type"]).toContain(
      "application/problem+json",
    );

    const body = JSON.parse(response.payload) as Record<string, unknown>;
    expect(body.code).toBe("email_already_registered");
    expect(body.detail).toBe(
      "An account already exists for that email address.",
    );
  });

  it("forwards the request body to the upstream intact", async () => {
    await app.inject({
      ...publicRegister,
      payload: { email: "someone@example.com", tenancy: "company" },
    });

    expect(JSON.parse(upstream.lastRequest?.body ?? "{}")).toEqual({
      email: "someone@example.com",
      tenancy: "company",
    });
  });
});

describe("circuit breaker", () => {
  it("does NOT open on 4xx responses", async () => {
    upstream.behaviour.status = 400;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject(publicRegister);
      expect(response.statusCode).toBe(400);
    }

    const status = await app.inject({ method: "GET", url: "/status" });
    const body = JSON.parse(status.payload) as {
      breakers: { name: string; state: string }[];
    };

    expect(
      body.breakers.find((b) => b.name === "identity-service")?.state,
    ).toBe("closed");
  });

  it("opens after the failure threshold of 5xx responses and sheds with 503 + Retry-After", async () => {
    upstream.behaviour.status = 500;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await app.inject(publicRegister);
    }

    const shed = await app.inject(publicRegister);

    expect(shed.statusCode).toBe(503);
    expect(shed.headers["retry-after"]).toBeDefined();

    const body = JSON.parse(shed.payload) as Record<string, unknown>;
    expect(body.code).toBe("upstream_unavailable");

    const countBefore = upstream.requests.length;
    await app.inject(publicRegister);
    expect(upstream.requests).toHaveLength(countBefore);
  });

  it("admits exactly one trial request after the reset timeout, and closes on success", async () => {
    upstream.behaviour.status = 500;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await app.inject(publicRegister);
    }

    expect((await app.inject(publicRegister)).statusCode).toBe(503);

    await new Promise((resolve) => setTimeout(resolve, 260));

    upstream.behaviour.status = 202;
    const trial = await app.inject(publicRegister);
    expect(trial.statusCode).toBe(202);

    expect((await app.inject(publicRegister)).statusCode).toBe(202);
  });
});

describe("unreachable upstream", () => {
  it("answers 503 with Retry-After rather than a 500 or a hang", async () => {
    await upstream.stop();

    try {
      const response = await app.inject(publicRegister);

      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBeDefined();

      const body = JSON.parse(response.payload) as Record<string, unknown>;
      expect(body.code).toBe("upstream_unavailable");
      expect(String(body.detail)).not.toContain("ECONNREFUSED");
    } finally {
      await upstream.start();
    }
  });
});

describe("readiness", () => {
  it("does not report itself unready because an upstream is down", async () => {
    await upstream.stop();

    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(200);
    } finally {
      await upstream.start();
    }
  });
});
