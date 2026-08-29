import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

function depcruiseBin(): string {
  const packageDir = resolvePath(REPO_ROOT, "node_modules/dependency-cruiser");
  const manifestPath = resolvePath(packageDir, "package.json");

  if (!existsSync(manifestPath)) {
    throw new Error(
      `dependency-cruiser is not installed (looked in ${packageDir}). Run pnpm install.`,
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: Record<string, string> | string;
  };

  const bin = manifest.bin;
  const relative = typeof bin === "string" ? bin : bin?.depcruise;

  if (relative === undefined) {
    throw new Error("dependency-cruiser declares no depcruise bin");
  }

  return resolvePath(packageDir, relative);
}

const MINIMUM_MODULES = 20;

type CruiseViolation = {
  readonly rule: { readonly name: string; readonly severity: string };
  readonly from: string;
  readonly to: string;
};

type CruiseDependency = {
  readonly module: string;
  readonly resolved?: string;
  readonly couldNotResolve?: boolean;
};

type CruiseModule = {
  readonly source: string;
  readonly dependencies: readonly CruiseDependency[];
};

type CruiseResult = {
  readonly summary: {
    readonly totalCruised: number;
    readonly totalDependenciesCruised: number;
    readonly violations: readonly CruiseViolation[];
    readonly error: number;
    readonly warn: number;
    readonly info: number;
  };
  readonly modules: readonly CruiseModule[];
};

function fail(message: string): never {
  process.stderr.write(`\n  ARCHITECTURE CHECK FAILED\n  ${message}\n\n`);
  process.exit(1);
}

function isCruiseResult(value: unknown): value is CruiseResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { summary?: unknown; modules?: unknown };

  if (!Array.isArray(candidate.modules)) {
    return false;
  }

  const summary = candidate.summary;
  if (typeof summary !== "object" || summary === null) {
    return false;
  }

  const { totalCruised, violations } = summary as {
    totalCruised?: unknown;
    violations?: unknown;
  };

  return typeof totalCruised === "number" && Array.isArray(violations);
}

const [targetArg, configArg] = process.argv.slice(2);
const target = targetArg ?? "src";
const configFile = configArg ?? ".dependency-cruiser.cjs";

const cruise = spawnSync(
  process.execPath,
  [depcruiseBin(), target, "--config", configFile, "--output-type", "json"],
  { encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 },
);

if (cruise.error !== undefined) {
  fail(`could not run depcruise: ${cruise.error.message}`);
}

if (typeof cruise.stdout !== "string" || cruise.stdout.trim().length === 0) {
  fail(
    `depcruise produced no output (exit ${String(cruise.status)}).\n  ${
      cruise.stderr || "no stderr"
    }`,
  );
}

let parsed: unknown;
try {
  parsed = JSON.parse(cruise.stdout);
} catch {
  fail(
    `depcruise output was not JSON (exit ${String(cruise.status)}).\n  ${cruise.stderr}`,
  );
}

if (!isCruiseResult(parsed)) {
  fail("depcruise output did not have the expected shape.");
}

const { summary, modules } = parsed;

/* -------------------------------------------------------------------------- */
/* Tripwire 1 — the cruise must have analysed real modules.                    */
/* -------------------------------------------------------------------------- */

if (summary.totalCruised === 0) {
  fail(
    "depcruise cruised 0 modules, which it reports as success.\n" +
      "  Almost always a transpiler problem: dependency-cruiser supports\n" +
      "  typescript >=2.0.0 <7.0.0, and a newer TypeScript makes every .ts file\n" +
      "  unparseable. Check `pnpm exec depcruise src --config .dependency-cruiser.cjs`\n" +
      "  for a missing-typescript-transpiler warning.",
  );
}

if (summary.totalCruised < MINIMUM_MODULES) {
  fail(
    `depcruise cruised only ${String(summary.totalCruised)} modules, below the ` +
      `floor of ${String(MINIMUM_MODULES)}.\n` +
      "  Either the source tree shrank dramatically or the input was narrowed by\n" +
      "  a bad path argument or an over-broad `exclude`.",
  );
}

/* -------------------------------------------------------------------------- */
/* Tripwire 2 — every edge must resolve, or the rules match nothing.           */
/* -------------------------------------------------------------------------- */

const unresolved = modules.flatMap((module) =>
  module.dependencies
    .filter((dependency) => dependency.couldNotResolve === true)
    .map((dependency) => `${module.source} -> ${dependency.module}`),
);

if (unresolved.length > 0) {
  const shown = unresolved.slice(0, 10).join("\n    ");
  const more =
    unresolved.length > 10
      ? `\n    ...and ${String(unresolved.length - 10)} more`
      : "";

  fail(
    `${String(unresolved.length)} dependencies could not be resolved, so no rule ` +
      "can match them:\n    " +
      shown +
      more +
      "\n\n  If these are `#`-prefixed, `conditionNames` in .dependency-cruiser.cjs\n" +
      '  is missing "source" and every alias is resolving to a dist/ path that\n' +
      "  does not exist.",
  );
}

/* -------------------------------------------------------------------------- */
/* Tripwire 3 — every `#` subpath alias must land in src/.                     */
/* -------------------------------------------------------------------------- */

const misresolvedAliases = modules.flatMap((module) =>
  module.dependencies
    .filter(
      (dependency) =>
        dependency.module.startsWith("#") &&
        dependency.resolved !== undefined &&
        !dependency.resolved.startsWith("src/"),
    )
    .map(
      (dependency) =>
        `${module.source} -> ${dependency.module} (resolved to ${String(dependency.resolved)})`,
    ),
);

if (misresolvedAliases.length > 0) {
  fail(
    `${String(misresolvedAliases.length)} subpath imports resolved outside src/:\n    ` +
      misresolvedAliases.slice(0, 10).join("\n    ") +
      '\n\n  `conditionNames` in .dependency-cruiser.cjs must lead with "source", or the\n' +
      "  package.json imports map sends every `#` specifier to dist/ and the layer rules\n" +
      "  match nothing.",
  );
}

/* -------------------------------------------------------------------------- */
/* Tripwire 4 — the violations themselves.                                     */
/* -------------------------------------------------------------------------- */

if (summary.violations.length > 0) {
  const lines = summary.violations
    .map(
      (violation) =>
        `${violation.rule.severity}  ${violation.rule.name}: ${violation.from} -> ${violation.to}`,
    )
    .join("\n    ");

  fail(`${String(summary.violations.length)} rule violations:\n    ${lines}`);
}

process.stdout.write(
  `  architecture ok — ${String(summary.totalCruised)} modules, ` +
    `${String(summary.totalDependenciesCruised)} dependencies, ` +
    `all edges resolved, 0 violations\n`,
);
