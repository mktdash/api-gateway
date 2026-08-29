import { describe, expect, it } from "vitest";
import { SERVICE_REGISTRY } from "#config/service-registry";
import {
  isPublicPath,
  requestPathname,
  serviceForPathname,
} from "../request-path.ts";

describe("requestPathname", () => {
  it("strips the query string", () => {
    expect(requestPathname("/v1/auth/register?utm_source=email")).toBe(
      "/v1/auth/register",
    );
  });

  it("strips a fragment", () => {
    expect(requestPathname("/v1/auth/register#section")).toBe(
      "/v1/auth/register",
    );
  });

  it("handles an absolute-form request target, which is legal against a proxy", () => {
    expect(
      requestPathname("http://gateway.internal:8080/v1/auth/register?a=1"),
    ).toBe("/v1/auth/register");
  });

  it("returns / for an empty target", () => {
    expect(requestPathname("")).toBe("/");
  });

  it("does not decode percent-encoding", () => {
    expect(requestPathname("/v1/auth/%2e%2e/admin")).toBe(
      "/v1/auth/%2e%2e/admin",
    );
  });
});

describe("isPublicPath", () => {
  it.each([
    "/v1/auth/register",
    "/v1/auth/verify-email",
    "/v1/auth/verify-email/resend",
  ])("allows POST %s", (path) => {
    expect(isPublicPath("POST", path, SERVICE_REGISTRY)).toBe(true);
  });

  it("rejects a method the rule does not name", () => {
    expect(isPublicPath("GET", "/v1/auth/register", SERVICE_REGISTRY)).toBe(
      false,
    );
  });

  it("rejects a route that has not shipped upstream", () => {
    expect(isPublicPath("POST", "/v1/auth/login", SERVICE_REGISTRY)).toBe(
      false,
    );
  });

  it("rejects a neighbouring path that merely shares a prefix", () => {
    expect(
      isPublicPath("POST", "/v1/auth/register-admin", SERVICE_REGISTRY),
    ).toBe(false);
  });

  it("rejects a trailing-slash variant rather than tolerating it", () => {
    expect(isPublicPath("POST", "/v1/auth/register/", SERVICE_REGISTRY)).toBe(
      false,
    );
  });

  it("is case-sensitive on the path", () => {
    expect(isPublicPath("POST", "/v1/auth/Register", SERVICE_REGISTRY)).toBe(
      false,
    );
  });

  it("accepts a lowercase method name", () => {
    expect(isPublicPath("post", "/v1/auth/register", SERVICE_REGISTRY)).toBe(
      true,
    );
  });
});

describe("serviceForPathname", () => {
  it("routes a concrete auth path to identity-service", () => {
    expect(
      serviceForPathname("/v1/auth/register", SERVICE_REGISTRY)?.name,
    ).toBe("identity-service");
  });

  it("returns undefined for a path no service claims", () => {
    expect(
      serviceForPathname("/v1/contacts", SERVICE_REGISTRY),
    ).toBeUndefined();
  });

  it("does not match a prefix that is only a string prefix", () => {
    expect(
      serviceForPathname("/v1/authz/policies", SERVICE_REGISTRY),
    ).toBeUndefined();
  });
});
