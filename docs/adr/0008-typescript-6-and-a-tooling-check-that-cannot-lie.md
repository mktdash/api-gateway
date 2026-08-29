# ADR 0008 — TypeScript 6.0.3, and an architecture check that cannot report a false green

- **Status:** Accepted
- **Date:** 2026-08-24
- **Affects:** `package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `.dependency-cruiser.cjs`, `scripts/check-architecture.ts`, `eslint.config.mjs`

## Context

The repository was on **TypeScript 7.0.2**. `tsc` was happy. Two of the four quality
gates were not, and only one of them said so.

### 1. Lint was completely broken

```
Error: typescript-eslint does not support TS 7.0.
```

`typescript-eslint@8.67.0` throws unconditionally on `ts.versionMajorMinor >= 7`, and
declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"` — so TypeScript 7.0.2 violated
the declared peer range and pnpm recorded that violation across seven
`@typescript-eslint/*` packages. `pnpm lint` exited non-zero on every run.

### 2. The architecture check passed while inspecting nothing

```
✔ no dependency violations found (0 modules, 0 dependencies cruised)
```

Exit code **0**. `dependency-cruiser@18.2.0` gates its TypeScript support on
`>=2.0.0 <7.0.0`; under TypeScript 7 it cannot parse a single `.ts` file, so it found
nothing, violated nothing, and passed. The warning it printed alongside was advisory
only.

### 3. And a second false green underneath the first

Fixing the transpiler raised the count to 50 modules — but **62 dependency edges could
not be resolved**, which was every `#config/*` / `#lib/*` / `#plugins/*` import in the
repository. `enhancedResolveOptions.conditionNames` lacked `"source"`, so each subpath
specifier resolved through the `imports` map's `default` condition to a `./dist/*.js`
path that does not exist on a clean checkout.

Every layer rule in `.dependency-cruiser.cjs` — `config-is-a-leaf`,
`lib-no-plugins-or-routes`, `routes-not-plugins`, `no-app-from-below` — is expressed over
exactly those cross-folder edges. The rules matched nothing and reported clean.

## Decision

### 1. Align the repository on TypeScript `~6.0.3`

6.0.3 is a current stable release that satisfies **every** tool's declared range:

| Tool                        | Declared range   | 6.0.3 |        7.0.2        |
| --------------------------- | ---------------- | :---: | :-----------------: |
| `typescript-eslint@8.67.0`  | `>=4.8.4 <6.1.0` |  ✅   |    ❌ hard throw    |
| `dependency-cruiser@18.2.0` | `>=2.0.0 <7.0.0` |  ✅   | ❌ silent 0 modules |
| `tsc` (build + typecheck)   | —                |  ✅   |         ✅          |

Pinned `~6.0.3`, **not** `^6.0.3`: `^` would admit 6.1.0, which is outside
typescript-eslint's peer range and would reintroduce the breakage.

**A side-by-side install was attempted first and does not work for lint.**
`dependency-cruiser` has no peer dependency on `typescript`, so pnpm
`packageExtensions` can nest a 6.x under it — verified working, 50 modules cruised.
`typescript-eslint` declares `typescript` as a **peer**, and pnpm resolves peers from
the importer, so it always receives the root's TypeScript. Scoped `overrides` do not
change that. Giving lint a different TypeScript would mean a separate pnpm workspace
package holding its own `eslint` + `typescript-eslint` + `typescript@6`, with the app
compiled by TS 7 and linted by TS 6 — permanent dual-version divergence between what
compiles and what lints, for a ~30-file service whose typecheck already runs in under a
second.

This is a compatibility constraint with a concrete upstream resolution, not a preference.

**Revisit when both land:**

- typescript-eslint TS ≥7 support — [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)
- dependency-cruiser: _"Support for typescript@>=7 will follow when its API is published and stable."_

### 2. Split the tsconfigs

`projectService` could not parse `test/**` or `src/**/__tests__/**`, because the only
project excluded them — 11 parse errors, and no type-aware linting at all on the test
tree.

| File                  | Purpose                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tsconfig.json`       | `noEmit`, includes `src` + `test` + `scripts` + `vitest.config.ts`. Drives lint, the editor, and `pnpm typecheck`. |
| `tsconfig.build.json` | Extends it. `rootDir: ./src`, `outDir: ./dist`, excludes `__tests__`. Drives `pnpm build`.                         |

This replaces `tsconfig.tools.json`, so there is one typecheck command covering
everything rather than two covering overlapping subsets.

### 3. `conditionNames` must lead with `"source"`

```js
conditionNames: ["source", "import", "require", "node", "default", "types"],
```

Without it the layer rules are decorative. With it: **30 modules, 78 dependencies, 0
unresolved, 0 violations.**

### 4. Never trust `depcruise`'s exit code again

`pnpm depcruise` now runs `scripts/check-architecture.ts`, which reads the JSON report
and **fails** on any of:

| Tripwire                   | Why                                            |
| -------------------------- | ---------------------------------------------- |
| `totalCruised === 0`       | the transpiler case above — exits 0 on its own |
| `totalCruised < 20`        | a bad path argument or an over-broad `exclude` |
| any `couldNotResolve` edge | the alias case above — rules match nothing     |
| any rule violation         | the check's actual job                         |

`test/tooling/architecture-check.test.ts` proves each one fires, including by writing a
real forbidden import into `src/lib/` and asserting the **real** rule set rejects it.

### 5. `@types/node` matches the runtime

`@types/node` was `^26.2.0` against an `engines.node` of `>=22.20.0`. That types APIs
which do not exist at runtime: the typechecker approves a call that throws in production,
and nothing in CI can catch it because CI typechecks with the same wrong types.

Aligned to `^22.20.0`. Verified clean across typecheck, lint, the full suite and build.
Raise it in the same commit that raises `engines.node`, never before.

## Consequences

**All four gates now genuinely pass**: `typecheck`, `lint`, `depcruise`, `test`.

**`pnpm peers check` reports no issues.** It previously reported the TypeScript peer
violation across seven `@typescript-eslint/*` packages.

**Lint runs for the first time**, which surfaced 66 pre-existing findings. All fixed. One
deserves separate mention: an `eslint --fix` rewrote `interface FastifyRequest` in
`src/types/fastify.d.ts` into a `type` alias, and **type aliases cannot participate in
declaration merging** — the augmentation stopped extending Fastify's `FastifyRequest` and
started shadowing it, so `request.user` still resolved while `request.log` and
`request.headers` silently became error types, hidden from `tsc` by `skipLibCheck`.
`**/*.d.ts` is now exempt from `consistent-type-definitions`, with the reason recorded in
the file itself.

**No TypeScript 7 features may be used**, and none were — the codebase already avoids
`enum`, `namespace` and parameter properties for Node's native type stripping.

**`pnpm typecheck:tools` no longer exists.** `pnpm typecheck` covers the whole tree.

## Alternatives rejected

- **Stay on TS 7 and isolate only dependency-cruiser.** Fixes the architecture check and
  leaves `pnpm lint` broken — a state this repository's own definition of production-ready
  rules out.
- **Stay on TS 7 and drop type-aware linting.** Loses `no-floating-promises`, the
  `no-unsafe-*` family and `switch-exhaustiveness-check` on the service that is the
  platform's trust boundary. The rules that matter most here are exactly the ones that
  need type information.
- **Keep only the tripwire and leave TS 7.** The tripwire would then fail every run,
  which is honest but leaves the architecture unenforced.
- **Suppress the depcruise warning and move on.** The failure mode this ADR exists to
  prevent.
