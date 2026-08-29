# ADR 0009 — Redis is configured by discrete variables, not a URL

- **Status:** Accepted
- **Date:** 2026-08-24
- **Supersedes:** the `REDIS_URL` shape used since the client was introduced
- **Affects:** `src/config/env.ts`, `src/config/redis-url.ts`, `src/lib/redis-client.ts`, `.env.example`
- **Related:** [0005](./0005-permission-version-freshness.md) (permission freshness),
  [0006](./0006-redis-failure-behaviour.md) (fail-open behaviour)

## Context

This service and `identity-service` share one Redis instance and one key namespace
(`identity:pv:`). identity-service publishes the permission version; Argus reads it.
That makes the connection target a **cross-service contract**, not an internal
detail — the two must agree on host, port, and database index or the freshness check
reads `null` forever and silently passes every request.

Until now the two repos configured that shared instance differently. identity-service
used discrete `REDIS_HOST` / `PORT` / `USERNAME` / `PASSWORD` / `DB` / `TLS`
variables; Argus used a single `REDIS_URL`. The gateway's own agent definition
carried this as an open decision ("Redis connection config shape — single URL here vs
discrete vars in identity-service").

The divergence cost more than tidiness:

- **The db index hid inside a path segment.** `redis://…:6380/0` and
  `REDIS_DB=0` are the same fact written two ways. Nothing compared them, and a
  mismatch produces no error — just a permanently dormant `pv` check.
- **Credentials had to be URL-encoded by hand.** A password containing `@`, `/`, `:`
  or `#` silently truncates or misparses the authority. Discrete variables have no
  escaping rules.
- **The password could not be redacted from a log line** without parsing the URL
  back apart, so the connection target was never logged at all — which is exactly the
  line that would have answered "why can't the gateway reach Redis?"
- **TLS was implicit** in the `redis://` vs `rediss://` scheme rather than a named,
  reviewable mode.

## Decision

Adopt identity-service's shape verbatim: `REDIS_HOST`, `REDIS_PORT`,
`REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_DB`, `REDIS_TLS`. `REDIS_URL` is removed,
not deprecated — there is no dual-read period, because a service reading two config
shapes is how the two drift apart again.

`src/config/redis-url.ts` is a near-copy of identity-service's file of the same name,
carrying `toRedisAuthOptions()` (the AUTH-vs-ACL choice), `toRedisTlsOptions()`, and
a **redaction-only** URL composer. Argus deliberately does _not_ port
`composeRedisUrl()`: it builds the client from discrete `ioredis` options, so the
only URL it ever forms is the one it prints.

Three points where this repo diverges from identity-service, each deliberate:

1. **`REDIS_HOST` is optional here; it is required there.** identity-service cannot
   function without Redis. Argus can: both of its Redis uses are fail-open (ADR
   0006), and an unset `REDIS_HOST` is the documented "no Redis" state — the gateway
   boots, warns, serves, and reports the degradation on `/ready` and `/status`.
   `test/integration/redis-degraded.test.ts` is the suite that pins that behaviour.
   Making Redis mandatory here would delete a resilience property to buy symmetry.
2. **`maxRetriesPerRequest` stays at 1** (identity-service uses 2). Argus is on the
   hot path of every request in the platform with a 250 ms command timeout and a
   fail-open policy behind it. Failing fast and proceeding beats retrying.
3. **`connectionName` is `env.SERVICE_NAME`**, not a literal, so `CLIENT LIST` names
   the instance that opened the connection.

`REDIS_PASSWORD` is required when `NODE_ENV=production` and a host is configured,
matching identity-service. An unauthenticated Redis holding the session denylist and
the published permission version is a way to grant permissions, not just a cache.

## Consequences

- The two services' Redis configuration is now diffable line by line, and a
  `REDIS_DB` mismatch is visible in `.env` rather than buried in a URL path.
- The connection target is logged at boot, redacted
  (`redis://:[redacted]@127.0.0.1:6380/0`). `src/config/__tests__/redis-url.test.ts`
  asserts the password never survives composition.
- **This is a breaking environment change.** Every deployment target must replace
  `REDIS_URL` before this ships; the service will otherwise start with Redis
  unconfigured, which is a warning rather than a crash — by design, and therefore
  easy to miss. Grep for `REDIS_URL` in deployment configuration as part of the
  rollout, and check the `redis_unconfigured` log event after it.
- Empty `REDIS_USERNAME` means password-only `AUTH`, which is what a default Redis
  install expects. Set it only when connecting as a named ACL user.
