import { env } from "./env.ts";

export type UpstreamEnvVar = "IDENTITY_SERVICE_URL";

export const ANY_METHOD = "*";

export const GATEWAY_PUBLIC_PATHS: readonly PublicPathRule[] = [
  { method: "GET", path: "/health", match: "exact" },
  { method: "GET", path: "/ready", match: "exact" },
  { method: "GET", path: "/status", match: "exact" },
  { method: "GET", path: "/openapi.json", match: "exact" },
];

export const PROBE_PATHS: readonly string[] = ["/health", "/ready"];

export type PublicMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | typeof ANY_METHOD;

export type PublicPathRule = {
  readonly method: PublicMethod;
  readonly path: string;
  readonly match: "exact" | "prefix";
};

export type BreakerOverrides = {
  readonly failureThreshold?: number;
  readonly resetTimeoutMs?: number;
};

export type ServiceDefinition = {
  readonly name: string;
  readonly codename: string;
  readonly upstreamEnvVar: UpstreamEnvVar;
  readonly prefixes: readonly string[];
  readonly publicPaths: readonly PublicPathRule[];
  readonly openapiPath: string | null;
  readonly timeoutMs?: number;
  readonly breaker?: BreakerOverrides;
};

export const SERVICE_REGISTRY: readonly ServiceDefinition[] = [
  {
    name: "identity-service",
    codename: "themis",
    upstreamEnvVar: "IDENTITY_SERVICE_URL",
    prefixes: ["/v1/auth"],
    publicPaths: [
      { method: "POST", path: "/v1/auth/register", match: "exact" },
      { method: "POST", path: "/v1/auth/verify-email", match: "exact" },
      { method: "POST", path: "/v1/auth/verify-email/resend", match: "exact" },
    ],
    openapiPath: "/docs/json",
  },
];

export type ActiveService = ServiceDefinition & {
  readonly upstream: string;
};

export class ServiceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceRegistryError";
  }
}

function normalizePrefix(prefix: string): string {
  if (!prefix.startsWith("/")) {
    throw new ServiceRegistryError(
      `Path prefix "${prefix}" must start with "/".`,
    );
  }
  return prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
}

function prefixesOverlap(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const [shorter, longer] =
    left.length < right.length ? [left, right] : [right, left];
  return longer.startsWith(`${shorter}/`);
}

export function assertNoPrefixCollisions(
  definitions: readonly ServiceDefinition[],
): void {
  const claimed: { prefix: string; service: string }[] = [];

  for (const definition of definitions) {
    if (definition.prefixes.length === 0) {
      throw new ServiceRegistryError(
        `Service "${definition.name}" claims no path prefixes.`,
      );
    }

    for (const rawPrefix of definition.prefixes) {
      const prefix = normalizePrefix(rawPrefix);
      const clash = claimed.find((entry) =>
        prefixesOverlap(entry.prefix, prefix),
      );

      if (clash !== undefined) {
        throw new ServiceRegistryError(
          `Path prefix collision: "${definition.name}" claims "${prefix}", which overlaps "${clash.prefix}" claimed by "${clash.service}".`,
        );
      }

      claimed.push({ prefix, service: definition.name });
    }
  }
}

export function assertPublicPathsAreOwned(
  definitions: readonly ServiceDefinition[],
): void {
  for (const definition of definitions) {
    const prefixes = definition.prefixes.map(normalizePrefix);

    for (const rule of definition.publicPaths) {
      const owned = prefixes.some(
        (prefix) => rule.path === prefix || rule.path.startsWith(`${prefix}/`),
      );

      if (!owned) {
        throw new ServiceRegistryError(
          `Service "${definition.name}" declares public path "${rule.path}", which is outside its prefixes [${prefixes.join(", ")}].`,
        );
      }
    }
  }
}

export function validateRegistry(
  definitions: readonly ServiceDefinition[],
): void {
  assertNoPrefixCollisions(definitions);
  assertPublicPathsAreOwned(definitions);
}

validateRegistry(SERVICE_REGISTRY);

export function activeServices(
  definitions: readonly ServiceDefinition[] = SERVICE_REGISTRY,
): readonly ActiveService[] {
  return definitions.flatMap((definition) => {
    const upstream = env[definition.upstreamEnvVar];
    return upstream === undefined ? [] : [{ ...definition, upstream }];
  });
}

export function inactiveServiceNames(
  definitions: readonly ServiceDefinition[] = SERVICE_REGISTRY,
): readonly string[] {
  return definitions
    .filter((definition) => env[definition.upstreamEnvVar] === undefined)
    .map((definition) => definition.name);
}
