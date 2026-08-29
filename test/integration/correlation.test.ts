import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type GatewayApp } from "../../src/app.ts";
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

const publicRegister = {
  method: "POST" as const,
  url: "/v1/auth/register",
  headers: { "content-type": "application/json" },
  payload: {},
};

describe("x-request-id", () => {
  it("adopts the BFF's id, forwards it unchanged, and echoes it back", async () => {
    const response = await app.inject({
      ...publicRegister,
      headers: { ...publicRegister.headers, "x-request-id": "bff-01JABCDEF" },
    });

    expect(upstream.lastRequest?.headers["x-request-id"]).toBe("bff-01JABCDEF");
    expect(response.headers["x-request-id"]).toBe("bff-01JABCDEF");
  });

  it("mints one when absent, and uses the same value upstream and in the response", async () => {
    const response = await app.inject(publicRegister);

    const minted = response.headers["x-request-id"];
    expect(minted).toBeDefined();
    expect(upstream.lastRequest?.headers["x-request-id"]).toBe(minted);
  });

  it("refuses a malformed inbound id rather than propagating it into the log index", async () => {
    const response = await app.inject({
      ...publicRegister,
      headers: {
        ...publicRegister.headers,
        "x-request-id": "bad\nid with spaces",
      },
    });

    expect(response.headers["x-request-id"]).not.toContain("\n");
    expect(upstream.lastRequest?.headers["x-request-id"]).not.toContain("\n");
  });

  it("propagates traceparent alongside the request id", async () => {
    const traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    await app.inject({
      ...publicRegister,
      headers: { ...publicRegister.headers, traceparent },
    });

    expect(upstream.lastRequest?.headers.traceparent).toBe(traceparent);
  });
});

describe("hop-by-hop headers", () => {
  it("does not forward the gateway's own host header upstream", async () => {
    await app.inject({
      ...publicRegister,
      headers: { ...publicRegister.headers, host: "gateway.internal:8080" },
    });

    expect(upstream.lastRequest?.headers.host).not.toBe(
      "gateway.internal:8080",
    );
  });
});
