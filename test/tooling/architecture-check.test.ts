import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHECKER = resolve(REPO_ROOT, "scripts/check-architecture.ts");

function runChecker(...args: readonly string[]): {
  status: number | null;
  output: string;
} {
  const result = spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

const temporaryFiles: string[] = [];

afterEach(() => {
  while (temporaryFiles.length > 0) {
    const path = temporaryFiles.pop();
    if (path !== undefined) {
      rmSync(path, { force: true });
    }
  }
});

describe("architecture check", () => {
  it("passes on the real source tree and reports a real module count", () => {
    const { status, output } = runChecker();

    expect(status).toBe(0);
    expect(output).toContain("architecture ok");

    const modules = /architecture ok — (\d+) modules/u.exec(output);
    expect(modules).not.toBeNull();
    expect(Number(modules?.[1])).toBeGreaterThan(20);
  }, 60_000);

  it("FAILS when zero modules are cruised", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "argus-depcruise-empty-"));

    try {
      const { status, output } = runChecker(emptyDir);

      expect(status).toBe(1);
      expect(output).toContain("ARCHITECTURE CHECK FAILED");
      expect(output).toContain("cruised 0 modules");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("FAILS on a forbidden dependency, using the real rule set", () => {
    const tripwire = resolve(REPO_ROOT, "src/lib/__architecture-tripwire.ts");
    temporaryFiles.push(tripwire);

    writeFileSync(
      tripwire,
      'import securityPlugin from "#plugins/security.plugin";\n' +
        "export const violation = securityPlugin;\n",
      "utf8",
    );

    const { status, output } = runChecker();

    expect(status).toBe(1);
    expect(output).toContain("ARCHITECTURE CHECK FAILED");
    expect(output).toContain("lib-no-plugins-or-routes");
  }, 60_000);

  it("FAILS when subpath imports stop resolving into src", () => {
    const brokenConfig = resolve(REPO_ROOT, ".dependency-cruiser.broken.cjs");
    temporaryFiles.push(brokenConfig);

    writeFileSync(
      brokenConfig,
      "const base = require('./.dependency-cruiser.cjs');\n" +
        "module.exports = {\n" +
        "  ...base,\n" +
        "  options: {\n" +
        "    ...base.options,\n" +
        "    enhancedResolveOptions: {\n" +
        "      ...base.options.enhancedResolveOptions,\n" +
        "      conditionNames: ['import', 'require', 'node', 'default'],\n" +
        "    },\n" +
        "  },\n" +
        "};\n",
      "utf8",
    );

    const { status, output } = runChecker(
      "src",
      ".dependency-cruiser.broken.cjs",
    );

    expect(status).toBe(1);
    expect(output).toContain("ARCHITECTURE CHECK FAILED");
  }, 60_000);

  it("FAILS the same way whether or not dist/ has been built", () => {
    const brokenConfig = resolve(
      REPO_ROOT,
      ".dependency-cruiser.dist-case.cjs",
    );
    temporaryFiles.push(brokenConfig);

    writeFileSync(
      brokenConfig,
      "const base = require('./.dependency-cruiser.cjs');\n" +
        "module.exports = {\n" +
        "  ...base,\n" +
        "  options: {\n" +
        "    ...base.options,\n" +
        "    exclude: { path: '(^|/)(node_modules|coverage)/' },\n" +
        "    enhancedResolveOptions: {\n" +
        "      ...base.options.enhancedResolveOptions,\n" +
        "      conditionNames: ['import', 'require', 'node', 'default'],\n" +
        "    },\n" +
        "  },\n" +
        "};\n",
      "utf8",
    );

    mkdirSync(resolve(REPO_ROOT, "dist/lib"), { recursive: true });
    const decoy = resolve(REPO_ROOT, "dist/lib/logger.js");
    if (!existsSync(decoy)) {
      temporaryFiles.push(decoy);
      writeFileSync(decoy, "export const logger = {};\n", "utf8");
    }

    const { status, output } = runChecker(
      "src",
      ".dependency-cruiser.dist-case.cjs",
    );

    expect(status).toBe(1);
    expect(output).toContain("ARCHITECTURE CHECK FAILED");
  }, 60_000);
});
