import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "**/*.js",
      "**/*.cjs",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-shadow": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "process.env is read only in src/config/env.ts. Import the typed `env` instead.",
        },
        {
          selector: "TSEnumDeclaration",
          message:
            "enum is not erasable — Node strips types natively here. Use an `as const` object plus a derived union.",
        },
        {
          selector: "TSModuleDeclaration[kind='namespace']",
          message: "namespace is not erasable. Use ES modules.",
        },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "error",
    },
  },
  {
    files: ["src/config/env.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: ["**/*.d.ts", "test/setup/**/*.ts"],
    rules: { "@typescript-eslint/consistent-type-definitions": "off" },
  },
  {
    files: ["src/plugins/*.plugin.ts", "src/routes/*.routes.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
  {
    files: ["eslint.config.mjs", "vitest.config.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: ["test/**/*.ts", "src/**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/require-await": "off",
      "no-restricted-syntax": "off",
    },
  },
);
