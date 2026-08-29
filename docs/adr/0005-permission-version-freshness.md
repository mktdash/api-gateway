# ADR 0005 — Permission-version freshness: key contract and rollout modes

- **Status:** Accepted
- **Date:** 2026-08-24
- **Affects:** `src/lib/permission-version.ts`, `src/plugins/authenticate.plugin.ts`,
  `src/config/env.ts`, `src/routes/health.routes.ts`
- **Related:** [0006](./0006-redis-failure-behaviour.md) (Redis failure policy)
- **Requires a coordinated change in:** `identity-service`

## Context

Spec §4: **"Role changes take effect on the next request, not the next login."**

The token's `pv` claim is frozen at mint time from `memberships.permission_version`.
Trusting it means a demotion is invisible until the token expires — that is "next
refresh", up to fifteen minutes later, not "next request".

The correct construction is: identity-service publishes the current version to Redis
whenever it bumps one, and Argus does one `GET` per authenticated request and compares.

### What was actually here

`src/lib/permission-version.ts` existed and was well-formed, but **it never issued a
lookup.** The key was to be `identity:pv:<membershipId>`, and Argus cannot build that:
the access token carries no `mid` claim. Verified against
`identity-service/src/lib/jwt/claims.ts` — the claims are `sub`, `sid`, `org`, `ws?`,
`pv`, `typ`, `act?`, and there is no `membershipId` and no `roleId`.

So the check returned a `dormant` outcome on every request, without contacting Redis:

```ts
const check = await checkPermissionVersion(
  {}, // <- no subject could be built
  principal.permissionVersion,
  redis,
);
```

Refusing to fabricate a key that could never be hit was the right instinct. The
consequence was still that **spec §4 was satisfied by nothing**, on every request, for
every user.

### The second problem

Even with a key, identity-service **does not publish to `identity:pv:` at all** today.
The namespace appears in that repository only inside log-redaction test fixtures
(`observability/__tests__/serializers.test.ts`, `logger.test.ts`) — those are arbitrary
sample values, not a published contract. So every lookup returns "no such key", and
rejecting on that would `401` every request on the platform.

## Decision

### 1. Build the key from the claims the token actually carries

A membership _is_ the (user, workspace) pair — that is what carries the role. The
surrogate id is not the only way to name it, and both coordinates are in the token.

```
identity:pv:m:<membershipId>        preferred; used automatically if `mid` ever lands
identity:pv:w:<org>:<ws>:<sub>      workspace-scoped token
identity:pv:o:<org>:<sub>           org-scoped token (no `ws` claim)
```

Distinct discriminators (`m:` / `w:` / `o:`) so the three shapes can never collide.
`sub` and `org` are required claims, so the key is **always** resolvable — there is no
longer a state in which Argus knows who the caller is but cannot name their permission
key. `permissionVersionKey()` is the only definition of this contract in the repository.

**This is a published cross-service contract, not an internal cache detail.**
identity-service must write to these keys on every `permission_version` bump. Until it
does, see the modes below.

### 2. Make what an _absent_ key means a deployment decision

`PERMISSION_VERSION_MODE`, validated in `src/config/env.ts`:

| Mode                  | Published value differs      | Key absent     | Redis unreachable |
| --------------------- | ---------------------------- | -------------- | ----------------- |
| `off`                 | _(no lookup)_                | _(no lookup)_  | _(no lookup)_     |
| `monitor` _(default)_ | **reject** `401 token_stale` | allow, counted | allow, `warn`     |
| `enforce`             | **reject** `401 token_stale` | **reject**     | allow, `warn`     |

**A differing published version rejects in every mode that looks.** That is the security
property, and it is never softened — the mode only decides what an _absent_ key means,
and that question genuinely changes meaning the moment a publisher exists:

- **Today (`monitor`)** nothing publishes, so every key is absent. `enforce` would take
  the platform down.
- **Once identity-service publishes (`enforce`)** an absent key means the membership is
  gone or the publisher is broken. Neither should keep serving a token.

`off` is an incident escape hatch, not a default.

### 3. Reject with `401`, never `403`

The token is otherwise completely valid. `401 token_stale` tells the client to refresh
and retry; `403` would tell it this is a permanent denial. Argus makes no authorization
decisions — see [ADR 0002](./0002-gateway-vs-bff.md).

### 4. A broken publisher degrades, it does not reject

A published value that is not a plain non-negative decimal integer is treated as
`redis-down` (fail-open), not as a stale token. One bad write must not log the platform
out. The check is on the **string**, deliberately: `Number("")` and `Number("  ")` are
both `0` and `Number("1e3")` is `1000`, so a numeric check alone would read a broken
write as a real version and could reject a perfectly good token.

### 5. Make the dormant state impossible to mistake for a working one

`/status` reports `permissionVersion.comparing`. It is `false` until a request has
actually read a published value.

**Alert on `comparing === false`.** It is the difference between "the check is running
and everything matches" and "the check is running and there is nothing to compare
against" — which is the platform's real state today.

## Consequences

**The gateway side of spec §4 is complete and tested.**
`test/integration/permission-version.test.ts` publishes a differing version and asserts
the very next request is rejected, through a real EdDSA token and the real authenticate
plugin.

**The end-to-end property is still blocked on identity-service.** Argus now compares on
every authenticated request, but nothing writes the values yet. This ADR is the contract
that unblocks it; the gateway needs no further change when it lands.

**Redis is now on the hot path of every authenticated request** — one `GET`, bounded by
`REDIS_COMMAND_TIMEOUT_MS` (250 ms), failing open. See [ADR 0006](./0006-redis-failure-behaviour.md).

**When `mid` lands, `permissionVersionKey()` starts using it with no change here** —
but the published keys change shape, so it is a coordinated change, not a silent one.

### What identity-service must do

1. On every `memberships.permission_version` bump, `SET` the new value at the key shape
   above (`w:` when the membership has a workspace).
2. Give the key a TTL comfortably longer than the access-token lifetime, or no TTL.
3. Publish for existing memberships before the gateway is switched to `enforce`.
4. Then, and only then, set `PERMISSION_VERSION_MODE=enforce`.

## Alternatives rejected

- **Add a `mid` claim first, then implement.** Correct end state, but it invalidates
  every token in flight and needs changes across `claims.ts`, `signer.ts`,
  `authentication.service.ts`, its DTO and its tests. Meanwhile spec §4 stays satisfied
  by nothing. The seam here upgrades to `mid` for free when it arrives.
- **Key by `sub` alone.** Wrong: permission versions belong to a membership. A user in
  two workspaces would share one version, so a demotion in one silently invalidates
  their token in the other.
- **Key by `sid` (session).** `sid` is the unit of _revocation_, not of permissions. A
  role change must affect every session, not the one that happened to be minted last.
- **Trust the token's `pv` and check nothing.** This is what "dormant" amounted to. It
  satisfies spec §4 only if nobody reads the spec.
- **Reject on a missing key from day one.** Correct once publishing exists; a
  platform-wide outage before it does. That is precisely why the mode is a dial.
