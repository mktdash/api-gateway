import {
  ANY_METHOD,
  type PublicPathRule,
  type ServiceDefinition,
} from "#config/service-registry";

export function requestPathname(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) {
    try {
      return new URL(url).pathname;
    } catch {
      return "/";
    }
  }

  const queryAt = url.indexOf("?");
  const withoutQuery = queryAt === -1 ? url : url.slice(0, queryAt);

  const fragmentAt = withoutQuery.indexOf("#");
  const pathname =
    fragmentAt === -1 ? withoutQuery : withoutQuery.slice(0, fragmentAt);

  return pathname.length === 0 ? "/" : pathname;
}

function methodMatches(rule: PublicPathRule, method: string): boolean {
  return rule.method === ANY_METHOD || rule.method === method.toUpperCase();
}

function pathMatches(rule: PublicPathRule, pathname: string): boolean {
  if (rule.match === "exact") {
    return pathname === rule.path;
  }

  return pathname === rule.path || pathname.startsWith(`${rule.path}/`);
}

export function matchesPublicRule(
  method: string,
  pathname: string,
  rules: readonly PublicPathRule[],
): boolean {
  return rules.some(
    (rule) => methodMatches(rule, method) && pathMatches(rule, pathname),
  );
}

export function isPublicPath(
  method: string,
  pathname: string,
  definitions: readonly ServiceDefinition[],
): boolean {
  return definitions.some((definition) =>
    matchesPublicRule(method, pathname, definition.publicPaths),
  );
}

export function serviceForPathname<T extends ServiceDefinition>(
  pathname: string,
  definitions: readonly T[],
): T | undefined {
  return definitions.find((definition) =>
    definition.prefixes.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    ),
  );
}
