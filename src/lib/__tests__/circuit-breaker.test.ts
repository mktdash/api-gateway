import { describe, expect, it } from "vitest";
import { BREAKER_STATES, CircuitBreaker } from "../circuit-breaker.ts";

function build(
  overrides: { failureThreshold?: number; resetTimeoutMs?: number } = {},
) {
  let now = 0;
  const breaker = new CircuitBreaker({
    name: "test-upstream",
    failureThreshold: overrides.failureThreshold ?? 3,
    resetTimeoutMs: overrides.resetTimeoutMs ?? 1_000,
    now: () => now,
  });

  return {
    breaker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("closed -> open", () => {
  it("stays closed below the failure threshold", () => {
    const { breaker } = build({ failureThreshold: 3 });

    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.state).toBe(BREAKER_STATES.closed);
    expect(breaker.allowRequest()).toBe(true);
  });

  it("opens exactly at the threshold", () => {
    const { breaker } = build({ failureThreshold: 3 });

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.state).toBe(BREAKER_STATES.open);
    expect(breaker.allowRequest()).toBe(false);
  });

  it("resets the count on an intervening success", () => {
    const { breaker } = build({ failureThreshold: 3 });

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.state).toBe(BREAKER_STATES.closed);
  });
});

describe("4xx versus 5xx", () => {
  it("never opens on 4xx, however many arrive", () => {
    const { breaker } = build({ failureThreshold: 3 });

    for (let attempt = 0; attempt < 50; attempt += 1) {
      breaker.recordUpstreamStatus(400);
      breaker.recordUpstreamStatus(404);
      breaker.recordUpstreamStatus(409);
      breaker.recordUpstreamStatus(429);
    }

    expect(breaker.state).toBe(BREAKER_STATES.closed);
  });

  it("opens on repeated 5xx", () => {
    const { breaker } = build({ failureThreshold: 3 });

    breaker.recordUpstreamStatus(500);
    breaker.recordUpstreamStatus(502);
    breaker.recordUpstreamStatus(503);

    expect(breaker.state).toBe(BREAKER_STATES.open);
  });
});

describe("open -> half-open -> closed", () => {
  it("keeps shedding until the reset timeout elapses", () => {
    const { breaker, advance } = build({
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
    });

    breaker.recordFailure();
    advance(999);

    expect(breaker.allowRequest()).toBe(false);
  });

  it("admits exactly ONE trial request once the timeout elapses", () => {
    const { breaker, advance } = build({
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
    });

    breaker.recordFailure();
    advance(1_000);

    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.state).toBe(BREAKER_STATES.halfOpen);
    expect(breaker.allowRequest()).toBe(false);
    expect(breaker.allowRequest()).toBe(false);
  });

  it("closes when the trial succeeds", () => {
    const { breaker, advance } = build({
      failureThreshold: 1,
      resetTimeoutMs: 1_000,
    });

    breaker.recordFailure();
    advance(1_000);
    breaker.allowRequest();
    breaker.recordSuccess();

    expect(breaker.state).toBe(BREAKER_STATES.closed);
    expect(breaker.allowRequest()).toBe(true);
  });

  it("re-opens immediately when the trial fails, without waiting for the threshold again", () => {
    const { breaker, advance } = build({
      failureThreshold: 3,
      resetTimeoutMs: 1_000,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    advance(1_000);
    breaker.allowRequest();
    breaker.recordFailure();

    expect(breaker.state).toBe(BREAKER_STATES.open);
    expect(breaker.allowRequest()).toBe(false);
  });
});

describe("retryAfterSeconds", () => {
  it("counts down as the reset timeout elapses and never returns 0", () => {
    const { breaker, advance } = build({
      failureThreshold: 1,
      resetTimeoutMs: 10_000,
    });

    breaker.recordFailure();
    expect(breaker.retryAfterSeconds).toBe(10);

    advance(6_000);
    expect(breaker.retryAfterSeconds).toBe(4);

    advance(10_000);
    expect(breaker.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});
