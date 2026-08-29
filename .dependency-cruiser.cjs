module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "A cycle here means the registration order can never be reasoned about.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "error",
      comment: "Dead module. Delete it or wire it up.",
      from: {
        orphan: true,
        pathNot: ["^src/types/", "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$"],
      },
      to: {},
    },
    {
      name: "config-is-a-leaf",
      severity: "error",
      comment: "src/config may only depend on itself and src/types.",
      from: { path: "^src/config/" },
      to: { path: "^src/(?!config/|types/)" },
    },
    {
      name: "lib-no-plugins-or-routes",
      severity: "error",
      comment:
        "src/lib is transport-free: it may depend on src/config and src/lib only.",
      from: { path: "^src/lib/" },
      to: { path: "^src/(?!lib/|config/|types/)" },
    },
    {
      name: "lib-no-http",
      severity: "error",
      comment:
        "No HTTP types in src/lib. If a breaker or a key builder needs a FastifyRequest, the logic belongs in a plugin.",
      from: { path: "^src/lib/" },
      to: {
        path: "node_modules/(fastify|@fastify|fastify-plugin|fastify-type-provider-zod)",
      },
    },
    {
      name: "routes-not-plugins",
      severity: "error",
      comment:
        "A route must not import a plugin. Cross-cutting behaviour is registered in app.ts, in a documented order.",
      from: { path: "^src/routes/" },
      to: { path: "^src/plugins/" },
    },
    {
      name: "plugins-not-routes",
      severity: "error",
      comment: "A plugin must not import a route.",
      from: { path: "^src/plugins/" },
      to: { path: "^src/routes/" },
    },
    {
      name: "no-app-from-below",
      severity: "error",
      comment: "Nothing below the composition root may import it.",
      from: { path: "^src/(config|lib|plugins|routes)/" },
      to: { path: "^src/(app|server)\\.ts$" },
    },
    {
      name: "no-dev-dep-in-src",
      severity: "error",
      comment:
        "A devDependency imported from src/ is a production MODULE_NOT_FOUND waiting to happen.",
      from: { path: "^src/", pathNot: "(__tests__|\\.test\\.ts$)" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "no-deprecated-core",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["core"], path: "^(punycode|domain|sys)$" },
    },
    {
      name: "no-build-output-imports",
      severity: "error",
      comment:
        "Nothing in src/ may depend on compiled output. Defence in depth only — `exclude` " +
        "below drops dist/ from the graph, so the resolver-misconfiguration case this " +
        "guards against is caught by the subpath-resolution tripwire in " +
        "scripts/check-architecture.ts rather than here.",
      from: { path: "^src/" },
      to: { path: "^dist/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|coverage)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: [
        "source",
        "import",
        "require",
        "node",
        "default",
        "types",
      ],
      extensions: [".ts", ".js", ".mjs", ".cjs", ".json"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
