export const BREAKER_STATES = {
  closed: "closed",
  open: "open",
  halfOpen: "half-open",
} as const;

export type BreakerState = (typeof BREAKER_STATES)[keyof typeof BREAKER_STATES];

export type CircuitBreakerOptions = {
  readonly name: string;
  readonly failureThreshold: number;
  readonly resetTimeoutMs: number;
  readonly now?: () => number;
  readonly onTransition?: (transition: BreakerTransition) => void;
};

export type BreakerTransition = {
  readonly name: string;
  readonly from: BreakerState;
  readonly to: BreakerState;
  readonly consecutiveFailures: number;
};

export type BreakerSnapshot = {
  readonly name: string;
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
  readonly failureThreshold: number;
  readonly openedAt: number | null;
  readonly retryAfterSeconds: number;
};

export class CircuitBreaker {
  readonly name: string;

  readonly #failureThreshold: number;
  readonly #resetTimeoutMs: number;
  readonly #now: () => number;
  readonly #onTransition: ((transition: BreakerTransition) => void) | undefined;

  #state: BreakerState = BREAKER_STATES.closed;
  #consecutiveFailures = 0;
  #openedAt: number | null = null;
  #trialInFlight = false;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.#failureThreshold = Math.max(1, options.failureThreshold);
    this.#resetTimeoutMs = Math.max(1, options.resetTimeoutMs);
    this.#now = options.now ?? Date.now;
    this.#onTransition = options.onTransition;
  }

  get state(): BreakerState {
    return this.#state;
  }

  get retryAfterSeconds(): number {
    if (this.#openedAt === null) {
      return Math.ceil(this.#resetTimeoutMs / 1000);
    }

    const remaining = this.#openedAt + this.#resetTimeoutMs - this.#now();
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  allowRequest(): boolean {
    if (this.#state === BREAKER_STATES.closed) {
      return true;
    }

    if (this.#state === BREAKER_STATES.open) {
      if (this.#openedAt === null) {
        return true;
      }

      if (this.#now() - this.#openedAt < this.#resetTimeoutMs) {
        return false;
      }

      this.#transitionTo(BREAKER_STATES.halfOpen);
      this.#trialInFlight = true;
      return true;
    }

    if (this.#trialInFlight) {
      return false;
    }

    this.#trialInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.#trialInFlight = false;
    this.#consecutiveFailures = 0;
    this.#openedAt = null;

    if (this.#state !== BREAKER_STATES.closed) {
      this.#transitionTo(BREAKER_STATES.closed);
    }
  }

  recordFailure(): void {
    this.#trialInFlight = false;
    this.#consecutiveFailures += 1;

    if (this.#state === BREAKER_STATES.halfOpen) {
      this.#openedAt = this.#now();
      this.#transitionTo(BREAKER_STATES.open);
      return;
    }

    if (
      this.#state === BREAKER_STATES.closed &&
      this.#consecutiveFailures >= this.#failureThreshold
    ) {
      this.#openedAt = this.#now();
      this.#transitionTo(BREAKER_STATES.open);
    }
  }

  recordUpstreamStatus(statusCode: number): void {
    if (statusCode >= 500) {
      this.recordFailure();
      return;
    }

    this.recordSuccess();
  }

  reset(): void {
    this.#state = BREAKER_STATES.closed;
    this.#consecutiveFailures = 0;
    this.#openedAt = null;
    this.#trialInFlight = false;
  }

  snapshot(): BreakerSnapshot {
    return {
      name: this.name,
      state: this.#state,
      consecutiveFailures: this.#consecutiveFailures,
      failureThreshold: this.#failureThreshold,
      openedAt: this.#openedAt,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }

  #transitionTo(next: BreakerState): void {
    const from = this.#state;
    if (from === next) {
      return;
    }

    this.#state = next;
    this.#onTransition?.({
      name: this.name,
      from,
      to: next,
      consecutiveFailures: this.#consecutiveFailures,
    });
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function getBreaker(
  name: string,
  factory: () => CircuitBreaker,
): CircuitBreaker {
  const existing = breakers.get(name);
  if (existing !== undefined) {
    return existing;
  }

  const created = factory();
  breakers.set(name, created);
  return created;
}

export function breakerSnapshots(): readonly BreakerSnapshot[] {
  return [...breakers.values()].map((breaker) => breaker.snapshot());
}

export function resetBreakers(): void {
  for (const breaker of breakers.values()) {
    breaker.reset();
  }
}

export function clearBreakers(): void {
  breakers.clear();
}
