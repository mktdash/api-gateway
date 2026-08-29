import { describe, expect, it } from "vitest";
import {
  assertNoPrefixCollisions,
  assertPublicPathsAreOwned,
  SERVICE_REGISTRY,
  ServiceRegistryError,
  type ServiceDefinition,
} from "../service-registry.ts";

function service(overrides: Partial<ServiceDefinition>): ServiceDefinition {
  return {
    name: "example-service",
    codename: "example",
    upstreamEnvVar: "IDENTITY_SERVICE_URL",
    prefixes: ["/v1/example"],
    publicPaths: [],
    openapiPath: null,
    ...overrides,
  };
}

describe("prefix collisions", () => {
  it("accepts the shipped registry", () => {
    expect(() => {
      assertNoPrefixCollisions(SERVICE_REGISTRY);
    }).not.toThrow();
  });

  it("rejects two services claiming the identical prefix", () => {
    expect(() => {
      assertNoPrefixCollisions([
        service({ name: "a", prefixes: ["/v1/auth"] }),
        service({ name: "b", prefixes: ["/v1/auth"] }),
      ]);
    }).toThrow(ServiceRegistryError);
  });

  it("rejects a prefix that swallows another service's subtree", () => {
    expect(() => {
      assertNoPrefixCollisions([
        service({ name: "auth", prefixes: ["/v1/auth"] }),
        service({ name: "everything", prefixes: ["/v1"] }),
      ]);
    }).toThrow(/overlaps/u);
  });

  it("allows a prefix that merely shares a string prefix", () => {
    expect(() => {
      assertNoPrefixCollisions([
        service({ name: "auth", prefixes: ["/v1/auth"] }),
        service({ name: "authz", prefixes: ["/v1/authz"] }),
      ]);
    }).not.toThrow();
  });

  it("rejects a service claiming no prefixes at all", () => {
    expect(() => {
      assertNoPrefixCollisions([service({ prefixes: [] })]);
    }).toThrow(ServiceRegistryError);
  });

  it("rejects a prefix that does not start with a slash", () => {
    expect(() => {
      assertNoPrefixCollisions([service({ prefixes: ["v1/auth"] })]);
    }).toThrow(ServiceRegistryError);
  });
});

describe("public path ownership", () => {
  it("accepts the shipped registry", () => {
    expect(() => {
      assertPublicPathsAreOwned(SERVICE_REGISTRY);
    }).not.toThrow();
  });

  it("rejects a public path outside the declaring service's prefixes", () => {
    expect(() => {
      assertPublicPathsAreOwned([
        service({
          prefixes: ["/v1/example"],
          publicPaths: [
            { method: "POST", path: "/v1/billing/charge", match: "exact" },
          ],
        }),
      ]);
    }).toThrow(/outside its prefixes/u);
  });
});

describe("the shipped identity-service row", () => {
  it("declares exactly the three sign-up routes that have shipped", () => {
    const identity = SERVICE_REGISTRY.find(
      (s) => s.name === "identity-service",
    );

    expect(identity?.publicPaths.map((rule) => rule.path).sort()).toEqual([
      "/v1/auth/register",
      "/v1/auth/verify-email",
      "/v1/auth/verify-email/resend",
    ]);
  });

  it("declares every public path as an exact match, never a prefix", () => {
    const identity = SERVICE_REGISTRY.find(
      (s) => s.name === "identity-service",
    );

    for (const rule of identity?.publicPaths ?? []) {
      expect(rule.match).toBe("exact");
    }
  });
});
