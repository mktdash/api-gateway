# ADR 0002 — The BFF and the API Gateway are separate services

- **Status:** Accepted
- **Date:** 2026-08-24
- **Affects:** the whole of `src/`, and every future "can the gateway just…" conversation
- **Related:** [0004](./0004-public-routes-are-an-allowlist-not-an-order.md) (public routes),
  [0005](./0005-permission-version-freshness.md) (permission freshness)

## Context

Two hops sit between a browser and a domain service, and they are easy to confuse
because both "sit in the middle and forward requests":

- **`mktdash-web`'s BFF** — Next.js Route Handlers under
  `src/app/api/bff/[service]/[...path]/`. Part of the frontend deployment.
- **`api-gateway` (Argus)** — this repository. Part of the platform.

Without a written boundary the gateway is where every unowned concern lands. Each
individual request is reasonable — "just merge these two calls", "just reshape this
field for the table", "the service doesn't expose it yet" — and the end state is a
gateway that every team must coordinate a deploy around. That is the failure mode of
an API gateway: not that it breaks, but that it quietly becomes the place every
team's logic goes to die.

## Decision

Keep both, with the split below. **The BFF serves one client; the gateway serves
every client.**

### Request flow

```
                    ┌───────────────────────────────────────────┐
  browser  ────────▶│  mktdash-web BFF        (Next.js)         │
  (httpOnly         │                                           │
   cookie)          │  · cookie ──▶ Bearer                      │
                    │  · aggregates calls for ONE screen        │
                    │  · reshapes payloads for the UI           │
                    │  · frontend workflow orchestration        │
                    └───────────────────┬───────────────────────┘
                                        │  Bearer token
                                        ▼
                    ┌───────────────────────────────────────────┐
                    │  api-gateway  [Argus]                     │
                    │                                           │
                    │  · STRIPS client identity headers         │
                    │  · JWKS verify · typ · algorithm pin      │
                    │  · permission-version freshness           │
                    │  · routing table / service registry       │
                    │  · rate limit · CORS · security headers   │
                    │  · circuit breaker · timeouts             │
                    │  · x-request-id + traceparent             │
                    │  · SETS verified identity headers         │
                    └───────────────────┬───────────────────────┘
                                        │  x-user-id, x-org-id,
                                        │  x-workspace-id, …
                    ┌───────────────────┴───────────────────────┐
                    ▼                                           ▼
        ┌───────────────────────┐               ┌───────────────────────┐
        │ identity-service      │               │ future domain service │
        │ [themis]              │      …        │                       │
        │ · business logic      │               │ · business logic      │
        │ · domain rules        │               │ · domain rules        │
        │ · persistence         │               │ · persistence         │
        │ · domain authorization│               │ · domain authorization│
        └───────────────────────┘               └───────────────────────┘
```

### Who owns what

| Concern                                                | BFF | Gateway | Service |
| ------------------------------------------------------ | :-: | :-----: | :-----: |
| Session cookie ⇄ Bearer exchange                       |  ●  |         |         |
| Aggregating several calls for one screen               |  ●  |         |         |
| Reshaping a payload to suit a component                |  ●  |         |         |
| Frontend workflow orchestration (multi-step wizards)   |  ●  |         |         |
| Client-specific caching and revalidation               |  ●  |         |         |
| **Authentication** (JWKS verify, `typ`, algorithm pin) |     |    ●    |         |
| **Permission-version freshness**                       |     |    ●    |         |
| Identity-header trust boundary (strip, then set)       |     |    ●    |         |
| Routing table / service registry                       |     |    ●    |         |
| Per-user and per-token rate limiting                   |     |    ●    |         |
| CORS, security headers                                 |     |    ●    |         |
| Circuit breaking, upstream timeouts, retry policy      |     |    ●    |         |
| `x-request-id` and `traceparent` propagation           |     |    ●    |         |
| Edge error normalisation (RFC 9457)                    |     |    ●    |         |
| Upstream OpenAPI aggregation                           |     |    ●    |         |
| Business logic, domain rules                           |     |         |    ●    |
| Persistence                                            |     |         |    ●    |
| **Authorization** — may this principal do this?        |     |         |    ●    |
| Per-IP login throttling (pre-identity)                 |     |         |    ●    |

Three rules follow, and they are the ones that get argued about:

1. **The BFF never calls a domain service directly — only the gateway.** That is what
   makes "add a mobile client" or "expose a partner API" a config change rather than a
   rewrite. A second client gets the same routing, the same rate limits and the same
   identity guarantees for free.
2. **The gateway decides _authentication_; services decide _authorization_.** A request
   that passes Argus has a cryptographically verified principal. Whether that principal
   may perform the action is a domain question, needing domain state the gateway does not
   have and must not acquire. This is why Argus answers `401` and never `403`.
3. **The gateway does not reshape upstream responses.** Status, body and content type are
   forwarded untouched. A client debugging a `422` sees the service's `422`. A gateway
   that rewraps a service's error makes every downstream contract a lie.

### Why not merge them

**Why not put the BFF's job in the gateway?** UI-shaped responses are versioned with the
UI. Folding them in couples every frontend release to a platform deploy, and the shaping
serves exactly one client while the gateway serves all of them — the second client
inherits the first one's screen layouts.

**Why not put the gateway's job in the BFF?** It is a frontend deployment. Making it the
identity authority means a mobile client or partner API must either reimplement token
verification or route through the web app. It also puts the platform's single most
dangerous surface — the identity-header trust boundary — inside the deployment that
changes most often.

## Consequences

**A concern that is neither obviously routing nor obviously business logic goes to the
BFF, not to Argus.** The gateway's ratchet only turns one way, and this is the rule that
keeps it from turning.

**Adding a service is one object in `src/config/service-registry.ts`.** If it ever
requires editing `src/routes/proxy.routes.ts`, the registry abstraction has failed and
should be fixed rather than worked around.

**A response-shape change is a three-repo change**: identity-service's committed
`docs/openapi/identity-service.json` → Argus's aggregate at `/openapi.json` → orval's
generated client in `mktdash-web`. Trace it before assuming it is invisible.

**Argus has no database, no ORM and no migrations.** If a task needs persistent state
here, it is either a cache that can be lost without correctness impact, or it belongs in
a service.

### The test for a new request

> Would a second client — a mobile app, a partner integration, a CLI — need this
> behaviour, exactly as written?

**Yes** → gateway. **No** → BFF. **"It depends on the screen"** → BFF, always.

## Alternatives rejected

- **BFF only, no gateway.** Every non-web client reimplements JWT verification, or is
  routed through the web app's deployment. Rate limiting and circuit breaking end up
  per-client rather than per-platform.
- **Gateway only, no BFF.** Either the browser makes many round trips per screen, or the
  gateway grows screen-shaped endpoints — which is the same thing as a BFF, but deployed
  with the platform and shared by clients that do not want it.
- **Let the BFF call services directly for "simple" cases.** The exception becomes the
  rule, and the identity guarantee stops being a property of the platform: some requests
  carry a verified principal and some carry whatever the caller sent.
