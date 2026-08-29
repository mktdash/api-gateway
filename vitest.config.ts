import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ["source", "module", "node", "development|production"],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["./test/setup/jwks-server.ts"],
    setupFiles: ["./test/setup/environment.ts"],
    clearMocks: true,
    restoreMocks: true,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      PORT: "8080",
      SERVICE_NAME: "api-gateway",
      JWT_ISSUER: "https://identity.mktdash.local",
      JWT_AUDIENCE: "mktdash",
      TRUST_PROXY: "false",
      CORS_ALLOWED_ORIGINS: "http://localhost:3000",
      UPSTREAM_TIMEOUT_MS: "2000",
      BREAKER_FAILURE_THRESHOLD: "3",
      BREAKER_RESET_TIMEOUT_MS: "200",
      RATE_LIMIT_MAX: "10000",
      RATE_LIMIT_ANONYMOUS_MAX: "10000",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/types/**", "src/server.ts"],
    },
  },
});
