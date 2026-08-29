export const IDENTITY_HEADERS = [
  "x-user-id",
  "x-org-id",
  "x-workspace-id",
  "x-membership-id",
  "x-role-id",
  "x-session-id",
  "x-actor-user-id",
  "x-permission-version",
] as const;

export type IdentityHeader = (typeof IDENTITY_HEADERS)[number];

export const FORWARDED_FOR_HEADER = "x-forwarded-for";

export type VerifiedPrincipal = {
  readonly userId: string;
  readonly sessionId: string;
  readonly organizationId: string;
  readonly workspaceId?: string | undefined;
  readonly permissionVersion: number;
  readonly actorUserId?: string | undefined;
  readonly tokenId: string;
  readonly expiresAt: number;
};

export function stripIdentityHeaders(
  headers: Record<string, unknown>,
): readonly IdentityHeader[] {
  const stripped: IdentityHeader[] = [];

  for (const header of IDENTITY_HEADERS) {
    if (headers[header] !== undefined) {
      stripped.push(header);
      Reflect.deleteProperty(headers, header);
    }
  }

  return stripped;
}

export function identityHeadersFor(
  principal: VerifiedPrincipal,
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-user-id": principal.userId,
    "x-org-id": principal.organizationId,
    "x-session-id": principal.sessionId,
    "x-permission-version": String(principal.permissionVersion),
  };

  if (principal.workspaceId !== undefined) {
    headers["x-workspace-id"] = principal.workspaceId;
  }

  if (principal.actorUserId !== undefined) {
    headers["x-actor-user-id"] = principal.actorUserId;
  }

  return headers;
}
