import { pino, type Logger, type LoggerOptions } from "pino";
import { env, isDevelopment, isProduction } from "#config/env";
import { logCorrelation } from "./correlation.ts";

export const REDACTED = "[redacted]";

const REDACT_PATHS = [
  "authorization",
  "cookie",
  "token",
  "accessToken",
  "refreshToken",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "request.headers.authorization",
  "request.headers.cookie",
  "res.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
  "headers['set-cookie']",
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
] as const;

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { service: env.SERVICE_NAME, environment: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: { paths: [...REDACT_PATHS], censor: REDACTED },
  mixin: logCorrelation,
};

function createLogger(): Logger {
  if (isDevelopment && !isProduction) {
    return pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname,service,environment",
        },
      },
    });
  }

  return pino(baseOptions);
}

export const logger: Logger = createLogger();
export const securityLogger: Logger = logger.child({ retention: "security" });
