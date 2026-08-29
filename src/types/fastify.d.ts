import "fastify";
import type { IdentityHeader, VerifiedPrincipal } from "#lib/identity-headers";
import type { PermissionVersionOutcome } from "#lib/permission-version";

declare module "fastify" {
  interface FastifyRequest {
    user: VerifiedPrincipal | null;
    readonly requestId: string;
    upstreamService: string | null;
    pvOutcome: PermissionVersionOutcome | null;
    strippedIdentityHeaders: readonly IdentityHeader[] | null;
  }
}
