import { describe, expect, it } from "vitest";
import { trustProxySchema } from "../env.ts";

describe("TRUST_PROXY rejects the unsafe forms", () => {
  it.each([["true"], ["TRUE"], ["True"], ["  true  "]])(
    "rejects %j, which would trust a forged chain",
    (value) => {
      const result = trustProxySchema.safeParse(value);

      expect(result.success).toBe(false);
    },
  );

  it.each([["1"], ["2"], ["10"], ["  3  "]])(
    "rejects the bare hop count %j, whose meaning is not stable across Fastify patches",
    (value) => {
      const result = trustProxySchema.safeParse(value);

      expect(result.success).toBe(false);
    },
  );
});

describe("TRUST_PROXY accepts the safe forms", () => {
  it.each([["false"], ["FALSE"], [""], ["   "]])(
    "reads %j as `do not trust the chain`",
    (value) => {
      const result = trustProxySchema.safeParse(value);

      expect(result.success).toBe(true);
      expect(result.data).toBe(false);
    },
  );

  it.each([
    ["10.0.0.0/8"],
    ["127.0.0.1"],
    ["10.0.0.0/8,172.16.0.0/12"],
    ["::1"],
  ])("passes the explicit CIDR/IP list %j through unchanged", (value) => {
    const result = trustProxySchema.safeParse(value);

    expect(result.success).toBe(true);
    expect(result.data).toBe(value);
  });

  it("defaults to false when the variable is unset", () => {
    const result = trustProxySchema.safeParse(undefined);

    expect(result.success).toBe(true);
    expect(result.data).toBe(false);
  });
});
