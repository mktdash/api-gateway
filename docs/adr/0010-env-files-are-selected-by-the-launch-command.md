# ADR 0010 — Environment files are selected by the launch command, not by the code

- **Status:** Accepted
- **Date:** 2026-08-26
- **Supersedes:** the single `.env` file the `dev` script pointed at
- **Affects:** `package.json` scripts, `.env.example`, `.env.development`, `.env.production`
- **Related:** [0009](./0009-redis-configured-by-discrete-variables.md) (discrete Redis vars)

## Context

The repo carried one `.env`, referenced by `dev` as `node --env-file=.env`. Splitting
it into `.env.development` and `.env.production` raises the question of _who chooses
the file_, and there are two answers with very different failure modes.

The commonly-copied answer is to choose it at runtime:

```ts
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });
```

That construction is circular and fails in three distinct ways:

1. **It reads the variable it exists to populate.** `NODE_ENV` has to already be set
   in the real environment before the file loads — so the file that defines
   `NODE_ENV=production` can only be found by something that already knew it was
   production. When nothing set it, the path resolves to `.env.undefined`, which
   `dotenv` silently ignores: no file, no error, and every schema default applied as
   though that were the configuration.
2. **It runs too late.** ESM hoists all `import` statements above module body
   statements, so a `dotenv.config()` call in `server.ts` executes _after_ every
   imported module has already been evaluated. `src/config/env.ts` parses
   `process.env` at module scope (`export const env = loadEnv()`), so it would see an
   unpopulated environment and `process.exit(1)` before the loader ever ran. Working
   around that means a separate side-effecting module imported first — load-bearing
   import order that nothing enforces.
3. **It is a dependency for something the runtime already does.** `engines.node` is
   `>=22.20.0`; `--env-file` has been stable since 20.6 and loads the file before any
   user code is evaluated, which is precisely what (2) needs.

## Decision

**The launch command names the file. No code in `src/` knows env files exist.**

```jsonc
"dev":   "NODE_ENV=development node --watch --env-file=.env.development --conditions=source src/server.ts",
"start": "NODE_ENV=production  node --env-file-if-exists=.env.production dist/server.js",
"prod":  "pnpm run build && pnpm run start"
```

`src/config/env.ts` stays the only file that reads `process.env`, and it reads an
environment that is already populated. This matches identity-service's scripts
verbatim, which matters more than the merits of any alternative: two services in one
platform that boot differently are two runbooks.

Four details are deliberate:

- **`--env-file` for dev, `--env-file-if-exists` for start.** A missing
  `.env.development` is a developer's mistake and should stop the process with a
  message. A missing `.env.production` is the _normal_ production case — a container
  receives real environment variables from a secret store and has no file on disk —
  so `start` must not require one. The same command then works in both places.
- **`NODE_ENV` is set by the command as well as inside the file.** With
  `--env-file-if-exists` and no file, the schema's `.default("development")` would
  otherwise apply, and a production process would run with development semantics:
  no `REDIS_PASSWORD` requirement (ADR 0009), development log formatting, and
  `isProduction` false everywhere it is branched on. The prefix makes NODE_ENV
  correct independent of the file.
- **The real environment wins over the file** — verified on Node 22.20: a shell or
  orchestrator value is not overwritten by an entry in the env file. An injected
  secret therefore cannot be clobbered by a stale checked-out file, and the
  precedence order is the conventional one (real env > file > schema default).
- **Tests read neither file.** `vitest.config.ts` sets `test.env` inline. A suite
  whose result depends on a gitignored file on one machine is not a test.

`.env.development` and `.env.production` are both gitignored (`.env.*`, with
`!.env.example`); `.env.example` remains the single committed template and documents
the convention. The two live files are kept structurally identical, section for
section, so `diff .env.development .env.production` shows only the values that
genuinely differ per environment — the same diffability argument ADR 0009 made for
the Redis variables.

## Consequences

- `pnpm dev` works again. It pointed at `.env`, which no longer exists; under
  `--env-file` that is a hard startup failure rather than a silent fallback.
- **`.env.production` was a byte-for-byte copy of `.env.development`**, down to
  `NODE_ENV=development`, `TRUST_PROXY=false`, a `http://localhost:3000` CORS origin
  and the local Redis password. It is now a production template with placeholders and
  empty secrets. Two of those copied values are the reason this is worth a paragraph
  rather than a bullet: `TRUST_PROXY=false` behind a real load balancer attributes
  every request to the proxy's IP, which collapses identity-service's per-IP login
  throttle into one shared bucket and writes the wrong IP into every audit event; and
  a dev Redis password against a production instance fails closed at boot only
  because `NODE_ENV` is now genuinely `production`.
- **`REDIS_PASSWORD` is empty in `.env.production` on purpose.** Running `pnpm prod`
  locally with `REDIS_HOST` set therefore exits at boot with the ADR 0009 message.
  That is the intended behaviour: the secret comes from the secret store, and a
  placeholder that boots is worse than a blank that does not.
- No `dotenv` dependency is added, and no import in `server.ts` is order-sensitive.
- Adding a variable remains four steps in order: production secret store →
  `.env.example` → the schema in `src/config/env.ts` → the typed `env` field. The
  split adds a fifth in practice: mirror it into both local files, or `pnpm prod`
  fails where `pnpm dev` passed.
- The `NODE_ENV=x cmd` prefix is POSIX shell syntax and does not run on Windows
  `cmd.exe`. The platform targets macOS/Linux and Docker; a Windows contributor
  would need `cross-env` or WSL. Noted rather than solved.
