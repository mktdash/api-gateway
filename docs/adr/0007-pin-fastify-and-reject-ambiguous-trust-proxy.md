# ADR 0007 — Pin Fastify to `~5.12.1`, and reject every ambiguous `TRUST_PROXY` form

- **Status:** Accepted
- **Date:** 2026-08-24
- **Affects:** `package.json`, `src/config/env.ts`, `src/app.ts`,
  `test/integration/trust-proxy.test.ts`, `src/config/__tests__/trust-proxy-schema.test.ts`

## Context

`trustProxy` decides what `request.ip` resolves to. Argus overwrites the outbound
`X-Forwarded-For` with that value, and downstream:

- identity-service's **per-IP login throttle** keys on it, and
- **every audit event** records it as the client IP.

Get it wrong in one direction and every login on the platform shares a single throttle
bucket — a trivial platform-wide DoS. Get it wrong in the other and the audit log
records the gateway's pod IP on every breach anyone ever investigates.

**The meaning of a numeric `trustProxy` changed inside the Fastify 5 line.** Read out of
the installed sources:

| Fastify                   | `trustProxy: 2` compiles to | Effect             |
| ------------------------- | --------------------------- | ------------------ |
| 5.11.3 (identity-service) | `(addr, hop) => hop < 2`    | trusts 2 hops      |
| 5.12.1 (this repo)        | `() => false`               | trusts **nothing** |

5.12.0 made the change deliberately — a hop count alone cannot validate the immediate
peer. But the consequence is that the same configuration value means opposite things in
two services of the same platform, and an ordinary patch bump flips it with no error and
no warning. Fastify's own types have already dropped `number` from the union, which
means a project on JavaScript, or one that casts, gets the change silently.

A CIDR list compiles through `proxy-addr` identically in both versions.

## Decision

### 1. `src/config/env.ts` rejects the two ambiguous forms at boot

```
TRUST_PROXY=true   ->  rejected. Lets any caller forge the entire XFF chain.
TRUST_PROXY=3      ->  rejected. Means opposite things across a patch bump.
TRUST_PROXY=false  ->  accepted. The local-dev and default posture.
TRUST_PROXY=10.0.0.0/8,127.0.0.1
                   ->  accepted. The only form that survives a version change.
```

Rejection is a **boot failure**, not a warning. A gateway that starts with a half-valid
trust configuration is a gateway that mis-attributes every client IP on the platform
until somebody notices.

### 2. Pin `fastify` to `~5.12.1`

The lockfile already makes installs reproducible; the range governs what
`pnpm update` may do unattended. `~5.12.1` allows patch releases and makes a minor bump a
deliberate, reviewed act — appropriate for the single most dangerous configuration
surface in this repository.

Widening to `^5` is fine _after_ running `test/integration/trust-proxy.test.ts` against
the new version and confirming the table below still holds.

### 3. Assert the behaviour against the Fastify that is actually installed

`test/integration/trust-proxy.test.ts` builds bare Fastify instances and drives them with
a controlled socket peer, so these are properties of the framework rather than of Argus:

| Config                     | Peer           | `X-Forwarded-For`      | `request.ip`   |
| -------------------------- | -------------- | ---------------------- | -------------- |
| `false`                    | `10.0.0.9`     | `1.2.3.4`              | `10.0.0.9`     |
| `"10.0.0.0/8"`             | `10.0.0.9`     | `203.0.113.7`          | `203.0.113.7`  |
| `"10.0.0.0/8"`             | `198.51.100.4` | `203.0.113.7`          | `198.51.100.4` |
| `"10.0.0.0/8"`             | `10.0.0.9`     | `6.6.6.6, 203.0.113.7` | `203.0.113.7`  |
| `1` _(rejected by env)_    | `10.0.0.9`     | `203.0.113.7`          | `10.0.0.9`     |
| `true` _(rejected by env)_ | `198.51.100.4` | `6.6.6.6`              | `6.6.6.6`      |

The last two rows are never configured. They are asserted so the danger is demonstrated
rather than described in a comment, and so a Fastify upgrade that restores hop-count
semantics fails here loudly.

The suite also asserts the installed version still matches `5.12.x`, so the table cannot
silently describe a version nobody is running.

### 4. When `trustProxy` is false, ignore the inbound chain entirely

`request-context.plugin.ts` **overwrites** `X-Forwarded-For` with `request.ip` on every
request — it never merges or appends. "Set it only if absent" preserves the spoof.

## Consequences

**Production must set `TRUST_PROXY` to the actual ingress CIDRs.** Leaving it `false`
behind a load balancer makes every request appear to originate from the balancer, which
collapses identity-service's per-IP login throttle into one shared bucket. This is a
deployment checklist item, not a default that can be left alone.

**A Fastify minor bump is a reviewed change**, gated on re-running the trust-proxy suite.

**Local development stays `false`.** The BFF connects directly, so there is no proxy hop
and nothing to trust.

## Alternatives rejected

- **`trustProxy: true`.** Any caller can name any client IP. Not a configuration, a
  vulnerability.
- **Accept a hop count and document the version dependency.** The whole problem is that
  the value changes meaning silently. A comment does not survive a `pnpm update`.
- **Exact pin `5.12.1`.** Blocks genuine patch fixes for no benefit — the semantics
  change landed in a minor, and the regression suite catches a patch-level surprise.
- **`^5.12.1` with no regression test.** The behaviour would change on the next
  `pnpm update` with nothing to catch it, which is how this class of bug ships.
