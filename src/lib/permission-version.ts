import { env } from "#config/env";

export const PERMISSION_VERSION_NAMESPACE = "identity:pv:";

export const PV_OUTCOMES = {
  match: "match",
  stale: "stale",
  missingKey: "missing-key",
  redisDown: "redis-down",
  disabled: "disabled",
} as const;

export type PermissionVersionOutcome =
  (typeof PV_OUTCOMES)[keyof typeof PV_OUTCOMES];

export type PermissionVersionMode = "off" | "monitor" | "enforce";

export type PermissionVersionSubject = {
  readonly membershipId?: string | undefined;
  readonly userId: string;
  readonly organizationId: string;
  readonly workspaceId?: string | undefined;
};

export const PV_KEY_SHAPES = {
  membership: "membership",
  workspace: "workspace",
  organization: "organization",
} as const;

export type PermissionVersionKeyShape =
  (typeof PV_KEY_SHAPES)[keyof typeof PV_KEY_SHAPES];

export type PermissionVersionKey = {
  readonly key: string;
  readonly shape: PermissionVersionKeyShape;
};

export function permissionVersionKey(
  subject: PermissionVersionSubject,
): PermissionVersionKey {
  const { membershipId, userId, organizationId, workspaceId } = subject;

  if (membershipId !== undefined && membershipId.length > 0) {
    return {
      key: `${PERMISSION_VERSION_NAMESPACE}m:${membershipId}`,
      shape: PV_KEY_SHAPES.membership,
    };
  }

  if (workspaceId !== undefined && workspaceId.length > 0) {
    return {
      key: `${PERMISSION_VERSION_NAMESPACE}w:${organizationId}:${workspaceId}:${userId}`,
      shape: PV_KEY_SHAPES.workspace,
    };
  }

  return {
    key: `${PERMISSION_VERSION_NAMESPACE}o:${organizationId}:${userId}`,
    shape: PV_KEY_SHAPES.organization,
  };
}

export type PermissionVersionStore = {
  get(key: string): Promise<string | null>;
};

export type PermissionVersionCheck = {
  readonly outcome: PermissionVersionOutcome;
  readonly tokenVersion: number;
  readonly key?: string;
  readonly keyShape?: PermissionVersionKeyShape;
  readonly publishedVersion?: number;
  readonly reason?: string;
};

const counters: Record<PermissionVersionOutcome, number> = {
  [PV_OUTCOMES.match]: 0,
  [PV_OUTCOMES.stale]: 0,
  [PV_OUTCOMES.missingKey]: 0,
  [PV_OUTCOMES.redisDown]: 0,
  [PV_OUTCOMES.disabled]: 0,
};

export type PermissionVersionStats = {
  readonly namespace: string;
  readonly mode: PermissionVersionMode;
  readonly comparing: boolean;
  readonly outcomes: Readonly<Record<PermissionVersionOutcome, number>>;
};

export function permissionVersionStats(): PermissionVersionStats {
  return {
    namespace: PERMISSION_VERSION_NAMESPACE,
    mode: env.PERMISSION_VERSION_MODE,
    comparing: counters[PV_OUTCOMES.match] + counters[PV_OUTCOMES.stale] > 0,
    outcomes: { ...counters },
  };
}

export function resetPermissionVersionStats(): void {
  for (const key of Object.keys(counters) as PermissionVersionOutcome[]) {
    counters[key] = 0;
  }
}

function record(check: PermissionVersionCheck): PermissionVersionCheck {
  counters[check.outcome] += 1;
  return check;
}

export async function checkPermissionVersion(
  subject: PermissionVersionSubject,
  tokenVersion: number,
  store: PermissionVersionStore | null,
  mode: PermissionVersionMode = env.PERMISSION_VERSION_MODE,
): Promise<PermissionVersionCheck> {
  if (mode === "off") {
    return record({ outcome: PV_OUTCOMES.disabled, tokenVersion });
  }

  const { key, shape } = permissionVersionKey(subject);

  if (store === null) {
    return record({
      outcome: PV_OUTCOMES.redisDown,
      tokenVersion,
      key,
      keyShape: shape,
      reason: "redis_unconfigured",
    });
  }

  let raw: string | null;
  try {
    raw = await store.get(key);
  } catch (error) {
    return record({
      outcome: PV_OUTCOMES.redisDown,
      tokenVersion,
      key,
      keyShape: shape,
      reason: error instanceof Error ? error.name : "redis_error",
    });
  }

  if (raw === null) {
    return record({
      outcome: PV_OUTCOMES.missingKey,
      tokenVersion,
      key,
      keyShape: shape,
    });
  }

  const publishedVersion = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;

  if (!Number.isSafeInteger(publishedVersion)) {
    return record({
      outcome: PV_OUTCOMES.redisDown,
      tokenVersion,
      key,
      keyShape: shape,
      reason: "unparseable_published_value",
    });
  }

  return record({
    outcome:
      publishedVersion === tokenVersion ? PV_OUTCOMES.match : PV_OUTCOMES.stale,
    tokenVersion,
    key,
    keyShape: shape,
    publishedVersion,
  });
}

export function rejectsRequest(
  check: PermissionVersionCheck,
  mode: PermissionVersionMode = env.PERMISSION_VERSION_MODE,
): boolean {
  if (check.outcome === PV_OUTCOMES.stale) {
    return true;
  }

  return mode === "enforce" && check.outcome === PV_OUTCOMES.missingKey;
}
