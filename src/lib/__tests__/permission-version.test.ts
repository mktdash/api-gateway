import { beforeEach, describe, expect, it } from "vitest";
import {
  checkPermissionVersion,
  PERMISSION_VERSION_NAMESPACE,
  PV_KEY_SHAPES,
  PV_OUTCOMES,
  permissionVersionKey,
  permissionVersionStats,
  rejectsRequest,
  resetPermissionVersionStats,
  type PermissionVersionStore,
} from "../permission-version.ts";

const SUBJECT = {
  userId: "user-1",
  organizationId: "org-1",
  workspaceId: "ws-1",
} as const;

function store(behaviour: {
  value?: string | null;
  throws?: Error;
}): PermissionVersionStore {
  return {
    get: async (_key: string) => {
      if (behaviour.throws !== undefined) {
        throw behaviour.throws;
      }
      return behaviour.value ?? null;
    },
  };
}

function recordingStore(value: string | null): {
  store: PermissionVersionStore;
  keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    store: {
      get: async (key: string) => {
        keys.push(key);
        return value;
      },
    },
  };
}

beforeEach(() => {
  resetPermissionVersionStats();
});

describe("the identity:pv: key contract", () => {
  it("prefers a membership id when one is present, ready for a future `mid` claim", () => {
    expect(permissionVersionKey({ ...SUBJECT, membershipId: "mem-1" })).toEqual(
      {
        key: `${PERMISSION_VERSION_NAMESPACE}m:mem-1`,
        shape: PV_KEY_SHAPES.membership,
      },
    );
  });

  it("keys a workspace-scoped token by (org, workspace, user)", () => {
    expect(permissionVersionKey(SUBJECT)).toEqual({
      key: `${PERMISSION_VERSION_NAMESPACE}w:org-1:ws-1:user-1`,
      shape: PV_KEY_SHAPES.workspace,
    });
  });

  it("keys an org-scoped token by (org, user), since `ws` is optional", () => {
    expect(
      permissionVersionKey({ userId: "user-1", organizationId: "org-1" }),
    ).toEqual({
      key: `${PERMISSION_VERSION_NAMESPACE}o:org-1:user-1`,
      shape: PV_KEY_SHAPES.organization,
    });
  });

  it("gives the three shapes distinct discriminators so they cannot collide", () => {
    const keys = new Set([
      permissionVersionKey({ ...SUBJECT, membershipId: "x" }).key,
      permissionVersionKey(SUBJECT).key,
      permissionVersionKey({ userId: "user-1", organizationId: "org-1" }).key,
    ]);

    expect(keys.size).toBe(3);
  });

  it("is always resolvable, because sub and org are required claims", () => {
    expect(
      permissionVersionKey({ userId: "u", organizationId: "o" }).key,
    ).toContain(PERMISSION_VERSION_NAMESPACE);
  });

  it("ignores an empty membership id rather than building identity:pv:m:", () => {
    expect(permissionVersionKey({ ...SUBJECT, membershipId: "" }).shape).toBe(
      PV_KEY_SHAPES.workspace,
    );
  });
});

describe("outcomes", () => {
  it("issues a real lookup against the published namespace", async () => {
    const { store: recorder, keys } = recordingStore("4");

    await checkPermissionVersion(SUBJECT, 4, recorder, "monitor");

    expect(keys).toEqual([
      `${PERMISSION_VERSION_NAMESPACE}w:org-1:ws-1:user-1`,
    ]);
  });

  it("matches when the published version equals the token's", async () => {
    const check = await checkPermissionVersion(
      SUBJECT,
      4,
      store({ value: "4" }),
      "monitor",
    );

    expect(check.outcome).toBe(PV_OUTCOMES.match);
    expect(rejectsRequest(check, "monitor")).toBe(false);
  });

  it("is STALE when the published version differs — the whole point of the control", async () => {
    const check = await checkPermissionVersion(
      SUBJECT,
      4,
      store({ value: "5" }),
      "monitor",
    );

    expect(check.outcome).toBe(PV_OUTCOMES.stale);
    expect(check.publishedVersion).toBe(5);
  });

  it("rejects a stale token in monitor mode as well as enforce", async () => {
    const check = await checkPermissionVersion(
      SUBJECT,
      4,
      store({ value: "5" }),
      "monitor",
    );

    expect(rejectsRequest(check, "monitor")).toBe(true);
    expect(rejectsRequest(check, "enforce")).toBe(true);
  });

  it("rejects a demoted user whose published version moved backwards", async () => {
    const check = await checkPermissionVersion(
      SUBJECT,
      7,
      store({ value: "6" }),
      "monitor",
    );

    expect(check.outcome).toBe(PV_OUTCOMES.stale);
    expect(rejectsRequest(check, "monitor")).toBe(true);
  });

  it("distinguishes a missing key from a matching one", async () => {
    const check = await checkPermissionVersion(
      SUBJECT,
      4,
      store({ value: null }),
      "monitor",
    );

    expect(check.outcome).toBe(PV_OUTCOMES.missingKey);
  });

  it("allows a missing key in monitor mode and rejects it in enforce mode", async () => {
    const check = await checkPermissionVersion(
      SUBJECT,
      4,
      store({ value: null }),
      "monitor",
    );

    expect(rejectsRequest(check, "monitor")).toBe(false);
    expect(rejectsRequest(check, "enforce")).toBe(true);
  });

  it("fails open when Redis throws, matching identity-service's fail-open policy", async () => {
    const check = await checkPermissionVersion(
      SUBJECT,
      4,
      store({ throws: new Error("ECONNREFUSED") }),
      "enforce",
    );

    expect(check.outcome).toBe(PV_OUTCOMES.redisDown);
    expect(rejectsRequest(check, "enforce")).toBe(false);
  });

  it("fails open when Redis is unconfigured entirely, even under enforce", async () => {
    const check = await checkPermissionVersion(SUBJECT, 4, null, "enforce");

    expect(check.outcome).toBe(PV_OUTCOMES.redisDown);
    expect(check.reason).toBe("redis_unconfigured");
    expect(rejectsRequest(check, "enforce")).toBe(false);
  });

  it("does not treat an unparseable published value as a match or a stale token", async () => {
    const check = await checkPermissionVersion(
      SUBJECT,
      4,
      store({ value: "not-a-number" }),
      "enforce",
    );

    expect(check.outcome).toBe(PV_OUTCOMES.redisDown);
    expect(check.reason).toBe("unparseable_published_value");
    expect(rejectsRequest(check, "enforce")).toBe(false);
  });

  it.each([["4.5"], ["-1"], [""], ["  "], ["1e3"]])(
    "does not accept %j as a published version",
    async (value) => {
      const check = await checkPermissionVersion(
        SUBJECT,
        4,
        store({ value }),
        "monitor",
      );

      expect(check.outcome).not.toBe(PV_OUTCOMES.match);
      expect(check.outcome).not.toBe(PV_OUTCOMES.stale);
    },
  );

  it("skips the lookup entirely when the mode is off", async () => {
    const { store: recorder, keys } = recordingStore("999");

    const check = await checkPermissionVersion(SUBJECT, 4, recorder, "off");

    expect(check.outcome).toBe(PV_OUTCOMES.disabled);
    expect(keys).toEqual([]);
    expect(rejectsRequest(check, "off")).toBe(false);
  });
});

describe("stats surfaced on /status", () => {
  it("reports that nothing is being compared while every key is missing", async () => {
    await checkPermissionVersion(SUBJECT, 1, store({ value: null }), "monitor");
    await checkPermissionVersion(SUBJECT, 1, store({ value: null }), "monitor");

    const stats = permissionVersionStats();

    expect(stats.comparing).toBe(false);
    expect(stats.namespace).toBe(PERMISSION_VERSION_NAMESPACE);
    expect(stats.outcomes[PV_OUTCOMES.missingKey]).toBe(2);
  });

  it("reports that comparison is live once a published value is read", async () => {
    await checkPermissionVersion(SUBJECT, 1, store({ value: "1" }), "monitor");

    expect(permissionVersionStats().comparing).toBe(true);
  });

  it("counts each outcome separately", async () => {
    await checkPermissionVersion(SUBJECT, 1, store({ value: "1" }), "monitor");
    await checkPermissionVersion(SUBJECT, 1, store({ value: "2" }), "monitor");
    await checkPermissionVersion(SUBJECT, 1, store({ value: null }), "monitor");
    await checkPermissionVersion(SUBJECT, 1, null, "monitor");

    const { outcomes } = permissionVersionStats();

    expect(outcomes[PV_OUTCOMES.match]).toBe(1);
    expect(outcomes[PV_OUTCOMES.stale]).toBe(1);
    expect(outcomes[PV_OUTCOMES.missingKey]).toBe(1);
    expect(outcomes[PV_OUTCOMES.redisDown]).toBe(1);
  });
});
