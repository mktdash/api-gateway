# ADR 0004 — Public routes are an allowlist, not a registration order

- **Status:** Accepted
- **Date:** 2026-08-23
- **Affects:** `src/config/service-registry.ts`, `src/plugins/authenticate.plugin.ts`,
  `src/plugins/observability.plugin.ts`, `src/app.ts`

## Context

The plan for this repo — and the comments originally written into `app.ts` — held that
`/health`, `/ready`, `/status` and `/openapi.json` stay reachable without a token because
they are registered _before_ `authenticate.plugin.ts`, and that probe traffic stays out of
the access log because those routes are registered before `observability.plugin.ts`:

```
error-handler → request-context → security → under-pressure   (no auth opinion)
health + openapi                                              ("MUST stay public")
authenticate → rate-limit → observability → proxy             (protected)
```

That is false. Both plugins are wrapped in `fastify-plugin`, which hoists their hooks to
the **root** context, and a root-level `onRequest` hook fires for every route in the
application — including routes registered earlier.

Verified directly against `fastify@5.12.1`:

```
route registered BEFORE an fp-wrapped guard hook  -> 500 (guard ran)
route registered AFTER                            -> 500 (guard ran)
```

Confirmed against the real app: `/health`, `/ready`, `/status` and `/openapi.json` all
returned **401**. Every load-balancer probe and every orval document fetch would have been
rejected, by a mechanism whose comments claimed it worked.

The same error made the probe-traffic exclusion inert: `/health` and `/ready` were being
written to the access log on every poll.

## Decision

Do not express any auth or logging policy through registration order.

1. **`GATEWAY_PUBLIC_PATHS`** in `service-registry.ts` names Argus's own public routes
   explicitly, in the same shape as each service's `publicPaths`. `authenticate.plugin.ts`
   checks it before anything else.
2. **`PROBE_PATHS`** names the routes excluded from the access log, and
   `observability.plugin.ts` applies it as an explicit predicate. Probes are still logged
   at 400 and above — a failing readiness check is exactly what the index is for.
3. The comments in `app.ts` now state what order _does_ control (which hook observes a
   request first, so identity headers are stripped before anything else runs) and what it
   does not (whether a route is public).

## Consequences

Public status is greppable, testable and independent of the order plugins happen to be
registered in. `test/integration/authentication.test.ts` asserts all four routes answer
without a token, so a reordering cannot silently re-break them.

Registration order still matters for `request-context.plugin.ts`, which must own the first
`onRequest` hook: it strips client-supplied identity headers and overwrites
`X-Forwarded-For`, and both are security controls that must run before any other code sees
the request.

**The wider lesson, which applies to every plugin added later:** with `fastify-plugin`, a
hook is global. Any rule of the form "registered before X, so X does not apply" is wrong
by construction and will fail silently in the permissive direction. State the policy as
data and check it.
