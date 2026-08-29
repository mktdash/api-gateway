import { z } from "zod";
import {
  composeRedactedRedisUrl,
  REDIS_TLS_MODES,
  type RedisConnectionParts,
} from "./redis-url.ts";

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

export const trustProxySchema = z
  .string()
  .default("false")
  .refine((value) => value.trim().toLowerCase() !== "true", {
    message:
      "TRUST_PROXY=true lets any caller forge the whole X-Forwarded-For chain. Use `false` or a CIDR list.",
  })
  .refine((value) => !/^\d+$/u.test(value.trim()), {
    message:
      "TRUST_PROXY must not be a bare hop count: fastify >=5.12 reads a number as `trust nothing`, while <5.12 read it as `trust N hops`. Use `false` or an explicit CIDR/IP list (e.g. `10.0.0.0/8,127.0.0.1`).",
  })
  .transform((value): boolean | string => {
    const trimmed = value.trim();
    return trimmed.toLowerCase() === "false" || trimmed === ""
      ? false
      : trimmed;
  });

const originListSchema = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: port.default(8080),
    HOST: z.string().min(1).default("0.0.0.0"),
    SERVICE_NAME: z.string().min(1).default("api-gateway"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

    IDENTITY_SERVICE_URL: z.url().optional(),

    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),

    JWKS_URI: z.url(),
    JWKS_CACHE_MAX_AGE_MS: positiveInt.default(600_000),
    JWKS_COOLDOWN_MS: positiveInt.default(30_000),
    JWKS_TIMEOUT_MS: positiveInt.default(5_000),
    CLOCK_TOLERANCE_SECONDS: nonNegativeInt.default(5),

    REDIS_HOST: z.string().min(1).optional(),
    REDIS_PORT: port.default(6379),
    REDIS_USERNAME: z.string().default(""),
    REDIS_PASSWORD: z.string().default(""),
    REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
    REDIS_TLS: z.enum(REDIS_TLS_MODES).default("disable"),
    REDIS_COMMAND_TIMEOUT_MS: positiveInt.default(250),

    PERMISSION_VERSION_MODE: z
      .enum(["off", "monitor", "enforce"])
      .default("monitor"),

    TRUST_PROXY: trustProxySchema,
    CORS_ALLOWED_ORIGINS: originListSchema,
    BODY_LIMIT_BYTES: positiveInt.default(1_048_576),
    REQUEST_TIMEOUT_MS: positiveInt.default(30_000),

    UPSTREAM_TIMEOUT_MS: positiveInt.default(15_000),
    OPENAPI_FETCH_TIMEOUT_MS: positiveInt.default(3_000),

    BREAKER_FAILURE_THRESHOLD: positiveInt.default(5),
    BREAKER_RESET_TIMEOUT_MS: positiveInt.default(15_000),

    RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000),
    RATE_LIMIT_MAX: positiveInt.default(300),
    RATE_LIMIT_ANONYMOUS_MAX: positiveInt.default(60),

    MAX_EVENT_LOOP_DELAY_MS: positiveInt.default(1_000),
    MAX_EVENT_LOOP_UTILIZATION: z.coerce.number().gt(0).lte(1).default(0.98),
    PRESSURE_RETRY_AFTER_SECONDS: positiveInt.default(10),
  })
  .superRefine((value, ctx) => {
    if (
      value.NODE_ENV === "production" &&
      value.REDIS_HOST !== undefined &&
      value.REDIS_PASSWORD.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["REDIS_PASSWORD"],
        message:
          "must be set when NODE_ENV=production — this Redis carries the session denylist and the published permission version",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    process.stderr.write(
      `api-gateway: invalid environment\n${JSON.stringify(z.treeifyError(parsed.error), null, 2)}\n`,
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
export const isTest = env.NODE_ENV === "test";

export const trustProxy: boolean | string = env.TRUST_PROXY;

export const redisConnection: RedisConnectionParts | null =
  env.REDIS_HOST === undefined
    ? null
    : {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
        username: env.REDIS_USERNAME,
        password: env.REDIS_PASSWORD,
        db: env.REDIS_DB,
        tls: env.REDIS_TLS,
      };

export const redisTargetRedacted: string | null =
  redisConnection === null ? null : composeRedactedRedisUrl(redisConnection);
