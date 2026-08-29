import { importPKCS8, SignJWT } from "jose";
import { inject } from "vitest";

export const TEST_ISSUER = "https://identity.mktdash.local";
export const TEST_AUDIENCE = "mktdash";

export type TestTokenOptions = {
  readonly userId?: string;
  readonly sessionId?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string | undefined;
  readonly permissionVersion?: number;
  readonly actorUserId?: string;
  readonly type?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly expiresInSeconds?: number;
  readonly useForeignKey?: boolean;
};

export async function mintTestToken(
  options: TestTokenOptions = {},
): Promise<string> {
  const pkcs8 =
    options.useForeignKey === true
      ? inject("foreignPrivateKeyPkcs8")
      : inject("jwksPrivateKeyPkcs8");

  const privateKey = await importPKCS8(pkcs8, "EdDSA");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? 900;

  const claims: Record<string, unknown> = {
    typ: options.type ?? "access",
    sid: options.sessionId ?? "11111111-1111-4111-8111-111111111111",
    org: options.organizationId ?? "22222222-2222-4222-8222-222222222222",
    pv: options.permissionVersion ?? 1,
  };

  if (options.workspaceId !== undefined) {
    claims.ws = options.workspaceId;
  }

  if (options.actorUserId !== undefined) {
    claims.act = { sub: options.actorUserId };
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: inject("jwksKid"), typ: "JWT" })
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? TEST_AUDIENCE)
    .setSubject(options.userId ?? "33333333-3333-4333-8333-333333333333")
    .setJti("44444444-4444-4444-8444-444444444444")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresIn)
    .sign(privateKey);
}

export async function authHeader(
  options: TestTokenOptions = {},
): Promise<string> {
  return `Bearer ${await mintTestToken(options)}`;
}
