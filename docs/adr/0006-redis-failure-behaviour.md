# ADR 0006 — Redis failure behaviour: both uses fail open, and that is the trade-off

- **Status:** Accepted
- **Date:** 2026-08-24
- **Affects:** `src/lib/redis-client.ts`, `src/lib/permission-version.ts`,
  `src/plugins/rate-limit.plugin.ts`, `src/routes/health.routes.ts`, `src/server.ts`
- **Related:** [0005](./0005-permission-version-freshness.md)

## Context

Redis is Argus's only stateful dependency. Two things depend on it, and both are
security-relevant:

1. **Permission-version freshness** — one `GET` per authenticated request.
2. **Rate limiting** — the shared counter store for `@fastify/rate-limit`.

Neither failure mode raises an error to a caller, so the behaviour has to be decided
deliberately rather than discovered during an incident.

## Decision

### Per-feature classification

| Feature                      | Redis unavailable                                   | Classification               | Observable as                                                    |
| ---------------------------- | --------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| Permission-version freshness | check is skipped, request proceeds                  | **fail-open**                | `pv_check_degraded` at `warn`; `redis-down` counter on `/status` |
| Rate limiting                | falls back to per-instance in-memory counters       | **degraded** (not fail-open) | `rate_limit_store_in_memory` at `warn` on boot                   |
| JWT verification             | _unaffected_ — JWKS is fetched over HTTP, not Redis | **no impact**                | —                                                                |
| Liveness `/health`           | _unaffected_ — process only                         | **no impact**                | —                                                                |
| Readiness `/ready`           | reports `configured`/`ok`, still answers `200`      | **degraded**                 | `checks.redis` in the body                                       |

**Permission-version is fail-open in every mode, including `enforce`.** This matches
identity-service's own declared policy in `src/lib/redis/client.ts`:

```ts
export const REDIS_FAILURE_POLICIES = {
  permissionVersion: "fail-open",
  …
} as const satisfies Record<string, RedisFailurePolicy>;
```

Fail-closed would mean a Redis blip logs every user on the platform out simultaneously,
and they could not log back in — the login path needs the same Redis. A cache outage
would become a total outage.

**Rate limiting is `skipOnError: true`, and its fallback is worse than it looks.**
`@fastify/rate-limit` silently uses in-memory counters when it has no client. At N
replicas the effective limit becomes N × the configured max, and it resets on every
deploy. It only ever _under_-enforces, so nothing ever fails loudly.

### The combined risk, stated plainly

A Redis outage removes one security control and weakens another **at the same time**:

```
Redis unavailable
      │
      ├──▶ permission-version check skipped
      │      → a demoted or role-changed user keeps their old permissions
      │        until their access token expires (≤ 15 min)
      │
      └──▶ rate limiting drops to per-instance counters
             → effective limit becomes N × max across N replicas
```

**This is accepted.** The exposure window is bounded by the access-token lifetime, and
what is lost is _freshness_, not authentication: signature, issuer, audience, algorithm
pinning and the `typ` check are all unaffected, because they need only the JWKS. An
unauthenticated caller gains nothing from a Redis outage.

What is explicitly **not** accepted is this happening invisibly. Hence:

- `warn` on the first degraded check, with `event: "pv_check_degraded"`.
- `/status` exposes per-outcome counters including `redis-down`.
- `/status` exposes `permissionVersion.comparing`, which is `false` when nothing has
  ever been compared.
- Boot logs `redis_unconfigured` / `redis_connect_failed` / `redis_unavailable`.

### `/ready` does not fail on a Redis outage

`ready = redis.configured ? redis.ok : true`.

A gateway that reports itself unready over a cache is removed from the load balancer,
taking every service behind it offline. Both Redis uses are survivable; the gateway is
degraded, not broken, and says so in the body.

### Boot does not fail on a Redis outage

`src/server.ts` logs and continues. Exiting would mean a Redis blip during a rolling
deploy takes the whole platform edge down — the outcome fail-open exists to prevent.

### What must never leak

Redis keys embed user and organization ids, and the `identity:pv:` namespace is
platform-internal. Neither the key, the namespace, nor the underlying error text appears
in any response body — `detail` is a fixed string and the `requestId` is the handle into
the log. Asserted in `test/integration/redis-degraded.test.ts` and
`test/integration/permission-version.test.ts`.

## Consequences

**Alerting requirements** — these are the signals that make the trade-off acceptable:

| Signal                        | Threshold             | Means                           |
| ----------------------------- | --------------------- | ------------------------------- |
| `pv_check_degraded` rate      | any sustained rate    | freshness is not being enforced |
| `permissionVersion.comparing` | `false` in production | nothing is publishing versions  |
| `rate_limit_store_in_memory`  | present at boot       | limits are per-replica          |
| `redis-down` outcome counter  | rising                | as above, quantified            |

**Monitoring the gap is the control.** With fail-open chosen, the only thing standing
between "a demotion is briefly ineffective" and "nobody noticed for a month" is that
these are visible and alerted on.

**Revisit if the exposure window grows.** The bound is the access-token lifetime. If that
is ever raised substantially, revisit fail-open for `enforce` mode — a 15-minute window
is a different risk from a 24-hour one.

**Revisit if a hard-revocation requirement appears.** "Log this user out everywhere,
immediately, guaranteed" cannot be built on a fail-open cache. That needs a `sid`
denylist with a fail-closed policy, which is a different decision from this one and
should get its own ADR.

## Alternatives rejected

- **Fail closed on the permission check.** Turns a cache outage into a platform-wide
  logout that cannot self-heal, because logging back in needs the same Redis. Also
  contradicts identity-service's declared policy, so the two services would disagree
  about the same key.
- **Fail closed on rate limiting.** Rejects all traffic when the counter store is
  unreachable. A cache outage becomes a total outage, for a control whose purpose is
  protecting against excess traffic rather than against unauthorised traffic.
- **Gate `/ready` on Redis.** Removes the gateway from the load balancer and takes every
  service behind it offline, over a dependency both of whose uses are survivable.
- **Exit at boot when Redis is unreachable.** A crash loop during a Redis incident,
  exactly when the platform can least afford to lose its edge.
- **Cache permission versions in memory.** Trades a fresh-but-unavailable read for a
  stale-but-available one, and re-introduces the problem the check exists to solve.
