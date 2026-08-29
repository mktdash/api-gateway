# ADR 0003 — Buffer proxied request bodies instead of streaming them

- **Status:** Accepted
- **Date:** 2026-08-23
- **Supersedes:** nothing
- **Affects:** `src/routes/proxy.routes.ts`

## Context

`@fastify/http-proxy` was chosen over hand-rolled `fetch` forwarding partly because it
streams request bodies rather than buffering uploads into memory. Its default,
`proxyPayloads: true`, hands `@fastify/reply-from` the raw Node request stream and lets
undici consume it.

While wiring the identity-service sign-up flow, the unreachable-upstream case did not
produce the `503 + Retry-After` this repo promises. It produced a raw
`Error: connect ECONNREFUSED` escaping the request lifecycle.

Isolated against `@fastify/http-proxy@11.6.1` / `@fastify/reply-from@12.6.4`, with an
upstream pointed at a closed port and an `onError` handler registered:

```
GET  /v1/auth/register (no body)   -> onError fires,      503 + Retry-After   correct
POST /v1/auth/register (with body) -> onError NEVER fires, raw error escapes  broken
```

The mechanism: undici destroys the request body stream with the connection error, which
surfaces on the Fastify request _before_ reply-from's own request callback runs. That
callback is the only place reply-from calls `replyOptions.onError`, so the hook is
bypassed entirely. The reply had already been finalised, so even the root
`setErrorHandler` could not answer — it logged and the injected request rejected.

This is not a corner case here. **Every route in the sign-up flow is a POST**
(`/v1/auth/register`, `/v1/auth/verify-email`, `/v1/auth/verify-email/resend`), so an
identity-service outage would have returned a raw 500 or a hang to the BFF rather than
the `upstream_unavailable` Problem Details the frontend branches on. The circuit breaker
would also never have recorded the failure, because it records in `onError`.

## Decision

Set **`proxyPayloads: false`** on every proxied service, and register a catch-all
content-type parser (`"*"`, `parseAs: "buffer"`) on the proxy context.

Fastify parses the body into a Buffer; reply-from sends it as a value rather than a
stream; `onError` fires normally and the breaker sees the failure.

The catch-all parser is required alongside it. `proxyPayloads: false` makes Fastify parse
the body, and Fastify answers `415` for a content type it has no parser for — so without
it, Argus would start rejecting `multipart/form-data` and `application/octet-stream` at
the edge, having formed an opinion about a payload it does not own.

## Consequences

**Accepted cost.** Request bodies are held in memory for the duration of the proxied
call, bounded by `BODY_LIMIT_BYTES` (1 MB here; identity-service's own limit is 64 KB).
No upload route exists behind the gateway today, and the only registered upstream serves
JSON auth payloads.

### What "buffered" actually costs

Every in-flight request holds its whole body in the gateway's heap until the upstream has
answered. Peak memory is therefore **concurrency × body size**, not body size:

| Body limit                            | 100 concurrent | 500 concurrent | 1 000 concurrent |
| ------------------------------------- | -------------- | -------------- | ---------------- |
| 64 KB (identity-service's own limit)  | 6 MB           | 32 MB          | 64 MB            |
| **1 MB (today's `BODY_LIMIT_BYTES`)** | **100 MB**     | **500 MB**     | **1 GB**         |
| 10 MB (a modest CSV)                  | 1 GB           | 5 GB           | 10 GB            |
| 100 MB (a video or a large export)    | 10 GB          | 50 GB          | 100 GB           |

Two properties of that table matter more than the numbers:

- **It is superlinear in impact, not just in size.** A slow upstream raises concurrency at
  the same time as slow clients raise how long each buffer is held. The two multiply.
- **The failure is the gateway, not the route.** A gateway OOM takes down _every_ service
  behind it, including ones that were serving small JSON perfectly well. A buffered
  upload route does not degrade itself; it degrades the platform edge.

`BODY_LIMIT_BYTES` is the only thing bounding this today, and it is the control that
matters. It is deliberately 1 MB — comfortably above any JSON auth payload and far below
anything that could be called a file.

### Criteria for revisiting — any ONE of these

Do not wait for all of them:

1. **A registry route accepts `multipart/form-data`.** The catch-all content-type parser
   means Argus will happily buffer it, silently. There is no error to notice.
2. **A route accepts a CSV, spreadsheet, or bulk import.** A "small" contact-list import
   is 5–50 MB, which is 50× today's limit.
3. **Any route needs `BODY_LIMIT_BYTES` raised above ~4 MB.** Treat a request to raise the
   limit as a request to revisit this ADR — that is usually the first visible symptom.
4. **A route accepts user-supplied media** — avatars, attachments, exports.
5. **p99 gateway RSS rises with request volume rather than staying flat.** Flat RSS under
   load is the signal that bodies are small and short-lived; a correlation is the signal
   that they are not.
6. **A partner or public API is exposed**, where body sizes are not controlled by a
   first-party client.

**Alert on the mechanical one now, before the judgement calls are needed:** gateway RSS,
and the rate of `413` responses. A rising `413` rate means somebody is already trying to
send something large through this path.

### What to do when one of them fires

In preference order:

1. **Route the upload around Argus.** Pre-signed URLs direct to object storage, or a
   dedicated upload host. The gateway never sees the bytes, so no limit needs raising and
   no failure mode needs re-litigating. This is almost always the right answer, and it is
   how uploads should be designed regardless of this ADR.
2. **A per-service `streamPayloads` flag in the registry.** Opt a single prefix into
   streaming, accepting for that prefix that an unreachable upstream produces a raw error
   rather than `503 upstream_unavailable`, and that the breaker will not record the
   failure. Requires its own ADR documenting which prefix knowingly loses the contract.
3. **Re-test whether `reply-from` has fixed it.** Re-run the GET/POST comparison above
   before assuming it has — the bug is silent, so an untested assumption reintroduces it.

**Do not simply raise `BODY_LIMIT_BYTES`.** It is the only bound on the table above, and
raising it converts a bounded, well-understood cost into an unbounded one without anybody
making a decision.

**Do not silently flip `proxyPayloads` back to `true`.** The `503` contract and the
circuit breaker both depend on it, and neither failure announces itself: the breaker
simply stops counting, and clients start seeing raw 500s instead of a `Retry-After` they
can act on.

**Track upstream.** If `reply-from` routes body-stream errors through `onError`, this ADR
can be reversed. Re-run the GET/POST comparison above before assuming it has been fixed.

## Alternatives rejected

- **Catch it in `setErrorHandler` instead.** Does not work: the reply is already finalised
  by the time the error arrives, so nothing can be sent. It also would not let the breaker
  attribute the failure to a specific upstream.
- **Hand-roll `fetch` forwarding.** Trades one well-understood library limitation for a
  whole surface of header, streaming and status-preservation bugs to write ourselves.
- **Ship it and document the gap.** The gateway's core promise is bounded, fail-fast
  behaviour on every upstream call. A documented hole on the only routes we serve is not
  a gateway.
