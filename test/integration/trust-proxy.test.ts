import { fastify } from "fastify";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const FASTIFY_VERSION = (require("fastify/package.json") as { version: string })
  .version;

const instances: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  while (instances.length > 0) {
    await instances.pop()?.close();
  }
});

async function ipEchoServer(trustProxy: boolean | string | number) {
  const app = fastify({ trustProxy: trustProxy as boolean | string });
  app.get("/ip", (request, reply) => {
    void reply.send({ ip: request.ip, ips: request.ips ?? null });
  });
  await app.ready();
  instances.push(app);
  return app;
}

async function resolvedIp(
  app: Awaited<ReturnType<typeof ipEchoServer>>,
  options: { forwardedFor: string; remoteAddress: string },
): Promise<string> {
  const response = await app.inject({
    method: "GET",
    url: "/ip",
    headers: { "x-forwarded-for": options.forwardedFor },
    remoteAddress: options.remoteAddress,
  });

  return (JSON.parse(response.payload) as { ip: string }).ip;
}

describe("the installed fastify", () => {
  it("is a 5.12.x release, which package.json pins deliberately", () => {
    expect(FASTIFY_VERSION).toMatch(/^5\.12\./u);
  });
});

describe("trustProxy = false", () => {
  it("ignores the forwarded chain entirely and uses the socket peer", async () => {
    const app = await ipEchoServer(false);

    const ip = await resolvedIp(app, {
      forwardedFor: "1.2.3.4",
      remoteAddress: "10.0.0.9",
    });

    expect(ip).toBe("10.0.0.9");
  });
});

describe("trustProxy = a CIDR list", () => {
  it("trusts the forwarded client when the peer is inside the range", async () => {
    const app = await ipEchoServer("10.0.0.0/8");

    const ip = await resolvedIp(app, {
      forwardedFor: "203.0.113.7",
      remoteAddress: "10.0.0.9",
    });

    expect(ip).toBe("203.0.113.7");
  });

  it("ignores the forwarded client when the peer is OUTSIDE the range", async () => {
    const app = await ipEchoServer("10.0.0.0/8");

    const ip = await resolvedIp(app, {
      forwardedFor: "203.0.113.7",
      remoteAddress: "198.51.100.4",
    });

    expect(ip).toBe("198.51.100.4");
  });

  it("takes the last untrusted hop from a forged multi-hop chain", async () => {
    const app = await ipEchoServer("10.0.0.0/8");

    const ip = await resolvedIp(app, {
      forwardedFor: "6.6.6.6, 203.0.113.7",
      remoteAddress: "10.0.0.9",
    });

    expect(ip).toBe("203.0.113.7");
  });
});

describe("trustProxy = a bare hop count", () => {
  it("trusts NOTHING on this Fastify, which is why env.ts rejects the form", async () => {
    const app = await ipEchoServer(1);

    const ip = await resolvedIp(app, {
      forwardedFor: "203.0.113.7",
      remoteAddress: "10.0.0.9",
    });

    expect(ip).toBe("10.0.0.9");
  });
});

describe("trustProxy = true", () => {
  it("lets a caller forge its own IP, which is why env.ts refuses the value", async () => {
    const app = await ipEchoServer(true);

    const ip = await resolvedIp(app, {
      forwardedFor: "6.6.6.6",
      remoteAddress: "198.51.100.4",
    });

    expect(ip).toBe("6.6.6.6");
  });
});
