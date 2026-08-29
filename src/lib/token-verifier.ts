import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import { z } from "zod";
import { env } from "#config/env";
import {
  tokenInvalidError,
  tokenWrongTypeError,
  upstreamUnavailableError,
  type GatewayError,
} from "./errors.ts";
import type { VerifiedPrincipal } from "./identity-headers.ts";

export const JWT_ALGORITHM = "EdDSA";
export const ACCESS_TOKEN_TYPE = "access";

const BEARER_PREFIX = /^Bearer[ ]+/iu;

const jwks = createRemoteJWKSet(new URL(env.JWKS_URI), {
  cacheMaxAge: env.JWKS_CACHE_MAX_AGE_MS,
  cooldownDuration: env.JWKS_COOLDOWN_MS,
  timeoutDuration: env.JWKS_TIMEOUT_MS,
});

const accessClaimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  org: z.string().min(1),
  ws: z.string().min(1).optional(),
  pv: z.number().int().nonnegative(),
  jti: z.string().min(1),
  exp: z.number().int().positive(),
  act: z.object({ sub: z.string().min(1) }).optional(),
});

export const JWKS_EVENTS = {
  fetchFailed: "jwks_fetch_failed",
} as const;

let jwksFailures = 0;
let lastJwksFailure: string | null = null;

export type JwksState = {
  readonly uri: string;
  readonly algorithm: string;
  readonly fetchFailures: number;
  readonly lastFailure: string | null;
};

export function jwksState(): JwksState {
  return {
    uri: env.JWKS_URI,
    algorithm: JWT_ALGORITHM,
    fetchFailures: jwksFailures,
    lastFailure: lastJwksFailure,
  };
}

export function bearerToken(authorization: unknown): string | undefined {
  if (typeof authorization !== "string" || !BEARER_PREFIX.test(authorization)) {
    return undefined;
  }

  const token = authorization.replace(BEARER_PREFIX, "").trim();
  return token.length === 0 ? undefined : token;
}

function jwksUnavailable(cause: unknown): GatewayError {
  jwksFailures += 1;
  lastJwksFailure = cause instanceof Error ? cause.name : "unknown";

  return upstreamUnavailableError({
    service: "identity-service",
    reason: "jwks_unreachable",
    retryAfterSeconds: 5,
    cause,
  });
}

function classifyVerificationError(error: unknown): GatewayError {
  if (error instanceof joseErrors.JWKSTimeout) {
    return jwksUnavailable(error);
  }

  if (error instanceof joseErrors.JWTExpired) {
    return tokenInvalidError("expired", error);
  }

  if (error instanceof joseErrors.JOSEAlgNotAllowed) {
    return tokenInvalidError("algorithm_not_allowed", error);
  }

  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return tokenInvalidError("signature_verification_failed", error);
  }

  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return tokenInvalidError(`claim_${error.claim}`, error);
  }

  if (
    error instanceof joseErrors.JWKSNoMatchingKey ||
    error instanceof joseErrors.JWKSMultipleMatchingKeys ||
    error instanceof joseErrors.JWKSInvalid
  ) {
    return tokenInvalidError("no_matching_key", error);
  }

  if (
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JOSENotSupported
  ) {
    return tokenInvalidError("malformed", error);
  }

  return jwksUnavailable(error);
}

export type VerifiedAccessToken = {
  readonly principal: VerifiedPrincipal;
};

export async function verifyAccessToken(
  token: string,
): Promise<VerifiedAccessToken> {
  let payload: Record<string, unknown>;

  try {
    const result = await jwtVerify(token, jwks, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: [JWT_ALGORITHM],
      clockTolerance: env.CLOCK_TOLERANCE_SECONDS,
    });
    payload = result.payload;
  } catch (error) {
    throw classifyVerificationError(error);
  }

  const tokenType = typeof payload.typ === "string" ? payload.typ : "";
  if (tokenType !== ACCESS_TOKEN_TYPE) {
    throw tokenWrongTypeError(tokenType === "" ? "absent" : tokenType);
  }

  const claims = accessClaimsSchema.safeParse(payload);
  if (!claims.success) {
    throw tokenInvalidError("claims_invalid");
  }

  const { sub, sid, org, ws, pv, jti, exp, act } = claims.data;

  return {
    principal: {
      userId: sub,
      sessionId: sid,
      organizationId: org,
      permissionVersion: pv,
      tokenId: jti,
      expiresAt: exp,
      ...(ws === undefined ? {} : { workspaceId: ws }),
      ...(act === undefined ? {} : { actorUserId: act.sub }),
    },
  };
}
