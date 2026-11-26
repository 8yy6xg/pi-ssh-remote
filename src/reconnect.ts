/**
 * Automatic SSH reconnect policy and supervisor.
 *
 * The supervisor is the single owner of reconnect timers and in-flight
 * attempts so /ssh-reconnect, /ssh-exit, and a second disconnect cannot
 * start stacked retry loops.
 */

export type ReconnectJitter = "full" | "none";

export interface ReconnectPolicy {
  readonly enabled: boolean;
  readonly initialDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
  readonly jitter: ReconnectJitter;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  enabled: true,
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 30_000,
  maxAttempts: 0,
  jitter: "full",
};

export type ConnectionLossClass =
  | "unexpected"
  | "auth-failure"
  | "host-key-change"
  | "cancelled";

export type ReconnectStopReason =
  | "user-exit"
  | "auth-failure"
  | "host-key-change"
  | "disabled"
  | "cancelled"
  | "exhausted";

export type ReconnectState =
  | { readonly kind: "idle" }
  | {
    readonly kind: "scheduled";
    readonly attempt: number;
    readonly delayMs: number;
    readonly dueAt: number;
  }
  | { readonly kind: "attempting"; readonly attempt: number }
  | { readonly kind: "cancelled"; readonly reason: Exclude<ReconnectStopReason, "exhausted"> }
  | { readonly kind: "exhausted"; readonly attempts: number };

export interface ReconnectScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): { cancel(): void };
  random(): number;
}

export const defaultReconnectScheduler: ReconnectScheduler = {
  now: () => Date.now(),
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  },
  random: () => Math.random(),
};

export class FakeReconnectScheduler implements ReconnectScheduler {
  nowMs = 0;
  randomValue = 1;
  private nextId = 1;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  now(): number {
    return this.nowMs;
  }

  random(): number {
    return this.randomValue;
  }

  setTimeout(callback: () => void, delayMs: number): { cancel(): void } {
    const id = this.nextId++;
    this.timers.set(id, {
      dueAt: this.nowMs + Math.max(0, delayMs),
      callback,
    });
    return {
      cancel: () => {
        this.timers.delete(id);
      },
    };
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + Math.max(0, ms);
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0]);
      if (due.length === 0) {
        this.nowMs = target;
        return;
      }
      const [id, timer] = due[0];
      this.nowMs = timer.dueAt;
      this.timers.delete(id);
      timer.callback();
      await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

const AUTH_FAILURE_PATTERN =
  /permission denied|authentication (?:failed|failure)|all configured authentication methods failed|no supported authentication methods|unable to authenticate|password authentication (?:is )?required|password authentication was cancelled/i;

const HOST_KEY_PATTERN =
  /host key verification failed|remote host identification has changed|known_hosts|does not match OpenSSH known_hosts|marked @revoked|no directly trusted host key|WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED/i;

const CANCELLED_PATTERN =
  /SSH connection cancelled|The operation was aborted|This operation was aborted|Reconnect cancelled/i;

function errorMessage(error: unknown): string {
  const visited = new Set<unknown>();
  const parts: string[] = [];
  let current = error;
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("\n");
}

export function classifyConnectionLoss(error: unknown): ConnectionLossClass {
  const message = errorMessage(error);
  if (CANCELLED_PATTERN.test(message)) return "cancelled";
  if (HOST_KEY_PATTERN.test(message)) return "host-key-change";
  if (AUTH_FAILURE_PATTERN.test(message)) return "auth-failure";
  return "unexpected";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeNonNegativeMs(value: unknown, fallback: number): number {
  if (!isFiniteNumber(value) || value < 0) return fallback;
  return value;
}

function normalizeMultiplier(value: unknown, fallback: number): number {
  if (!isFiniteNumber(value) || value < 1) return fallback;
  return value;
}

function normalizeMaxAttempts(value: unknown, fallback: number): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) return fallback;
  return value;
}

export function normalizeReconnectPolicy(value: unknown): ReconnectPolicy {
  if (!value || typeof value !== "object") return { ...DEFAULT_RECONNECT_POLICY };
  const raw = value as Record<string, unknown>;
  const jitter = raw.jitter === "none" || raw.jitter === "full"
    ? raw.jitter
    : DEFAULT_RECONNECT_POLICY.jitter;
  return {
    enabled: typeof raw.enabled === "boolean"
      ? raw.enabled
      : DEFAULT_RECONNECT_POLICY.enabled,
    initialDelayMs: normalizeNonNegativeMs(
      raw.initialDelayMs,
      DEFAULT_RECONNECT_POLICY.initialDelayMs,
    ),
    multiplier: normalizeMultiplier(raw.multiplier, DEFAULT_RECONNECT_POLICY.multiplier),
    maxDelayMs: normalizeNonNegativeMs(raw.maxDelayMs, DEFAULT_RECONNECT_POLICY.maxDelayMs),
    maxAttempts: normalizeMaxAttempts(raw.maxAttempts, DEFAULT_RECONNECT_POLICY.maxAttempts),
    jitter,
  };
}

export function cappedBackoffDelayMs(policy: ReconnectPolicy, attempt: number): number {
  const safeAttempt = Math.max(1, attempt);
  const raw = policy.initialDelayMs * (policy.multiplier ** (safeAttempt - 1));
  if (!Number.isFinite(raw)) return policy.maxDelayMs;
  return Math.min(policy.maxDelayMs, raw);
}

export function nextReconnectDelayMs(
  policy: ReconnectPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const cap = cappedBackoffDelayMs(policy, attempt);
  if (policy.jitter === "none") return cap;
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return cap * unit;
}

export function canAutoRetry(options: {
  policy: ReconnectPolicy;
  classification: ConnectionLossClass;
  nextAttempt: number;
}): boolean {
  if (!options.policy.enabled) return false;
  if (options.classification !== "unexpected") return false;
  if (options.policy.maxAttempts > 0 && options.nextAttempt > options.policy.maxAttempts) {
    return false;
  }
  return true;
}

export interface ReconnectSupervisorOptions {
  getPolicy(): ReconnectPolicy;
  connect(signal: AbortSignal): Promise<void>;
  onStateChange?(state: ReconnectState, previous: ReconnectState): void;
  onStopped?(reason: ReconnectStopReason, error?: unknown): void;
  scheduler?: ReconnectScheduler;
}

export class ReconnectSupervisor {
  private stateValue: ReconnectState = { kind: "idle" };
  private attempt = 0;
  private timer: { cancel(): void } | undefined;
  private abort: AbortController | undefined;
  private readonly getPolicy: () => ReconnectPolicy;
  private readonly connect: (signal: AbortSignal) => Promise<void>;
  private readonly onStateChange?: (state: ReconnectState, previous: ReconnectState) => void;
  private readonly onStopped?: (reason: ReconnectStopReason, error?: unknown) => void;
  private readonly scheduler: ReconnectScheduler;

  constructor(options: ReconnectSupervisorOptions) {
    this.getPolicy = options.getPolicy;
    this.connect = options.connect;
    this.onStateChange = options.onStateChange;
    this.onStopped = options.onStopped;
    this.scheduler = options.scheduler ?? defaultReconnectScheduler;
  }

  get state(): ReconnectState {
    return this.stateValue;
  }

  notifyUnexpectedLoss(): void {
    if (this.stateValue.kind === "scheduled" || this.stateValue.kind === "attempting") {
      return;
    }
    this.scheduleNext();
  }

  notifyAttemptFailed(error: unknown): void {
    if (this.stateValue.kind === "cancelled") return;
    const policy = this.getPolicy();
    const classification = classifyConnectionLoss(error);
    if (!canAutoRetry({
      policy,
      classification,
      nextAttempt: this.attempt + 1,
    })) {
      const reason: ReconnectStopReason = !policy.enabled
        ? "disabled"
        : classification === "auth-failure"
          ? "auth-failure"
          : classification === "host-key-change"
            ? "host-key-change"
            : classification === "cancelled"
              ? "cancelled"
              : "exhausted";
      if (reason === "exhausted") {
        this.setState({ kind: "exhausted", attempts: this.attempt });
      } else {
        this.setState({ kind: "cancelled", reason });
      }
      this.onStopped?.(reason, error);
      return;
    }
    this.scheduleNext();
  }

  notifyConnected(): void {
    this.clearTimer();
    this.abort = undefined;
    this.attempt = 0;
    this.setState({ kind: "idle" });
  }

  cancel(reason: "user-exit" | "cancelled"): void {
    this.clearTimer();
    this.abort?.abort();
    this.abort = undefined;
    this.attempt = 0;
    this.setState({ kind: "cancelled", reason });
  }

  disable(): void {
    const wasActive =
      this.stateValue.kind === "scheduled" || this.stateValue.kind === "attempting";
    this.clearTimer();
    this.abort?.abort();
    this.abort = undefined;
    this.setState({ kind: "cancelled", reason: "disabled" });
    if (wasActive) this.onStopped?.("disabled");
  }

  prepareManualRetry(): "in-flight" | "ready" {
    if (this.stateValue.kind === "attempting") {
      this.attempt = 0;
      return "in-flight";
    }
    this.clearTimer();
    this.attempt = 0;
    this.setState({ kind: "idle" });
    return "ready";
  }

  private scheduleNext(): void {
    const policy = this.getPolicy();
    const nextAttempt = this.attempt + 1;
    if (!canAutoRetry({
      policy,
      classification: "unexpected",
      nextAttempt,
    })) {
      this.setState({ kind: "exhausted", attempts: this.attempt });
      this.onStopped?.("exhausted");
      return;
    }
    const delayMs = nextReconnectDelayMs(
      policy,
      nextAttempt,
      () => this.scheduler.random(),
    );
    const dueAt = this.scheduler.now() + delayMs;
    this.setState({
      kind: "scheduled",
      attempt: nextAttempt,
      delayMs,
      dueAt,
    });
    this.clearTimer();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      void this.runAttempt(nextAttempt);
    }, delayMs);
  }

  private isCancelled(): boolean {
    return this.stateValue.kind === "cancelled";
  }

  private async runAttempt(attempt: number): Promise<void> {
    if (this.isCancelled()) return;
    this.attempt = attempt;
    this.abort = new AbortController();
    this.setState({ kind: "attempting", attempt });
    try {
      await this.connect(this.abort.signal);
      if (this.isCancelled()) return;
      this.notifyConnected();
    } catch (error) {
      if (this.isCancelled()) return;
      this.notifyAttemptFailed(error);
    }
  }

  private clearTimer(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  private setState(state: ReconnectState): void {
    const previous = this.stateValue;
    this.stateValue = state;
    if (previous !== state) this.onStateChange?.(state, previous);
  }
}
