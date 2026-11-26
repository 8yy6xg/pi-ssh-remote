import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_RECONNECT_POLICY,
  FakeReconnectScheduler,
  ReconnectSupervisor,
  canAutoRetry,
  cappedBackoffDelayMs,
  classifyConnectionLoss,
  nextReconnectDelayMs,
  normalizeReconnectPolicy,
  type ReconnectPolicy,
} from "../src/reconnect.ts";

const noJitter: ReconnectPolicy = {
  ...DEFAULT_RECONNECT_POLICY,
  jitter: "none",
};

test("capped exponential backoff is 1s, 2s, 4s, 8s, 16s, then 30s", () => {
  const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) =>
    cappedBackoffDelayMs(noJitter, attempt)
  );
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});

test("no jitter returns the capped backoff exactly", () => {
  assert.equal(nextReconnectDelayMs(noJitter, 3, () => 0), 4_000);
  assert.equal(nextReconnectDelayMs(noJitter, 3, () => 1), 4_000);
});

test("full jitter stays within [0, capped backoff]", () => {
  const cap = cappedBackoffDelayMs(DEFAULT_RECONNECT_POLICY, 4);
  assert.equal(cap, 8_000);
  assert.equal(nextReconnectDelayMs(DEFAULT_RECONNECT_POLICY, 4, () => 0), 0);
  assert.equal(nextReconnectDelayMs(DEFAULT_RECONNECT_POLICY, 4, () => 1), 8_000);
  assert.equal(nextReconnectDelayMs(DEFAULT_RECONNECT_POLICY, 4, () => 0.5), 4_000);
  const outOfRange = nextReconnectDelayMs(DEFAULT_RECONNECT_POLICY, 4, () => 2);
  assert.equal(outOfRange, 8_000);
  const negative = nextReconnectDelayMs(DEFAULT_RECONNECT_POLICY, 4, () => -1);
  assert.equal(negative, 0);
});

test("unlimited attempts keep retrying unexpected losses", () => {
  const policy = { ...DEFAULT_RECONNECT_POLICY, maxAttempts: 0 };
  for (const nextAttempt of [1, 2, 100, 10_000]) {
    assert.equal(
      canAutoRetry({ policy, classification: "unexpected", nextAttempt }),
      true,
      `attempt ${nextAttempt}`,
    );
  }
});

test("a positive maxAttempts stops after that many retries", () => {
  const policy = { ...DEFAULT_RECONNECT_POLICY, maxAttempts: 3 };
  assert.equal(canAutoRetry({ policy, classification: "unexpected", nextAttempt: 3 }), true);
  assert.equal(canAutoRetry({ policy, classification: "unexpected", nextAttempt: 4 }), false);
});

test("auth failure, host-key change, cancel, and a disabled policy do not auto-retry", () => {
  const enabled = DEFAULT_RECONNECT_POLICY;
  for (const classification of ["auth-failure", "host-key-change", "cancelled"] as const) {
    assert.equal(
      canAutoRetry({ policy: enabled, classification, nextAttempt: 1 }),
      false,
      classification,
    );
  }
  assert.equal(
    canAutoRetry({
      policy: { ...enabled, enabled: false },
      classification: "unexpected",
      nextAttempt: 1,
    }),
    false,
  );
});

test("classifyConnectionLoss distinguishes auth, host-key, cancel, and unexpected errors", () => {
  assert.equal(classifyConnectionLoss(new Error("Permission denied (publickey)")), "auth-failure");
  assert.equal(
    classifyConnectionLoss(new Error("All configured authentication methods failed")),
    "auth-failure",
  );
  assert.equal(
    classifyConnectionLoss(new Error("Host key verification failed")),
    "host-key-change",
  );
  assert.equal(
    classifyConnectionLoss(new Error("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")),
    "host-key-change",
  );
  assert.equal(
    classifyConnectionLoss(new Error("The host key presented by [localhost]:2222 does not match OpenSSH known_hosts")),
    "host-key-change",
  );
  assert.equal(classifyConnectionLoss(new Error("SSH connection cancelled")), "cancelled");
  assert.equal(classifyConnectionLoss(new Error("The operation was aborted")), "cancelled");
  assert.equal(classifyConnectionLoss(new Error("ssh2 connection closed")), "unexpected");
  assert.equal(classifyConnectionLoss(new Error("Connection refused")), "unexpected");
  assert.equal(classifyConnectionLoss(new Error("ECONNRESET")), "unexpected");
  assert.equal(
    classifyConnectionLoss(new Error("wrapped", { cause: new Error("Permission denied") })),
    "auth-failure",
  );
});

test("normalizeReconnectPolicy fills defaults and rejects invalid values", () => {
  assert.deepEqual(normalizeReconnectPolicy(undefined), DEFAULT_RECONNECT_POLICY);
  assert.deepEqual(
    normalizeReconnectPolicy({
      enabled: false,
      initialDelayMs: 2_000,
      multiplier: 3,
      maxDelayMs: 10_000,
      maxAttempts: 5,
      jitter: "none",
    }),
    {
      enabled: false,
      initialDelayMs: 2_000,
      multiplier: 3,
      maxDelayMs: 10_000,
      maxAttempts: 5,
      jitter: "none",
    },
  );
  assert.deepEqual(
    normalizeReconnectPolicy({
      enabled: "yes",
      initialDelayMs: -1,
      multiplier: 0.5,
      maxDelayMs: "slow",
      maxAttempts: 1.5,
      jitter: "equal",
    }),
    DEFAULT_RECONNECT_POLICY,
  );
});

test("the supervisor reconnects after an unexpected loss using backoff and does not stack loops", async () => {
  const scheduler = new FakeReconnectScheduler();
  const attempts: number[] = [];
  let shouldFail = true;
  const supervisor = new ReconnectSupervisor({
    getPolicy: () => noJitter,
    scheduler,
    connect: async () => {
      attempts.push(scheduler.nowMs);
      if (shouldFail) throw new Error("Connection refused");
    },
  });

  supervisor.notifyUnexpectedLoss();
  supervisor.notifyUnexpectedLoss();
  assert.equal(supervisor.state.kind, "scheduled");
  assert.equal(scheduler.pendingCount, 1);

  shouldFail = false;
  await scheduler.advance(1_000);
  assert.deepEqual(attempts, [1_000]);
  assert.equal(supervisor.state.kind, "idle");
  assert.equal(scheduler.pendingCount, 0);
});

test("failed unexpected reconnects follow exponential backoff until they succeed", async () => {
  const scheduler = new FakeReconnectScheduler();
  const attempts: number[] = [];
  let remainingFailures = 2;
  const supervisor = new ReconnectSupervisor({
    getPolicy: () => noJitter,
    scheduler,
    connect: async () => {
      attempts.push(scheduler.nowMs);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("Connection refused");
      }
    },
  });

  supervisor.notifyUnexpectedLoss();
  await scheduler.advance(1_000 + 2_000 + 4_000);
  assert.deepEqual(attempts, [1_000, 3_000, 7_000]);
  assert.equal(supervisor.state.kind, "idle");
});

test("maxAttempts stops the supervisor after the configured number of tries", async () => {
  const scheduler = new FakeReconnectScheduler();
  const attempts: number[] = [];
  let stopped: string | undefined;
  const supervisor = new ReconnectSupervisor({
    getPolicy: () => ({ ...noJitter, maxAttempts: 2 }),
    scheduler,
    connect: async () => {
      attempts.push(scheduler.nowMs);
      throw new Error("Connection refused");
    },
    onStopped: (reason) => {
      stopped = reason;
    },
  });

  supervisor.notifyUnexpectedLoss();
  await scheduler.advance(1_000 + 2_000 + 30_000);
  assert.deepEqual(attempts, [1_000, 3_000]);
  assert.deepEqual(supervisor.state, { kind: "exhausted", attempts: 2 });
  assert.equal(stopped, "exhausted");
  assert.equal(scheduler.pendingCount, 0);
});

test("authentication failure and host-key changes stop automatic retries", async () => {
  for (const [message, reason] of [
    ["Permission denied (publickey)", "auth-failure"],
    ["Host key verification failed", "host-key-change"],
  ] as const) {
    const scheduler = new FakeReconnectScheduler();
    const attempts: number[] = [];
    let stopped: string | undefined;
    const supervisor = new ReconnectSupervisor({
      getPolicy: () => noJitter,
      scheduler,
      connect: async () => {
        attempts.push(scheduler.nowMs);
        throw new Error(message);
      },
      onStopped: (next) => {
        stopped = next;
      },
    });
    supervisor.notifyUnexpectedLoss();
    await scheduler.advance(1_000 + 30_000);
    assert.deepEqual(attempts, [1_000], message);
    assert.equal(supervisor.state.kind, "cancelled");
    if (supervisor.state.kind === "cancelled") {
      assert.equal(supervisor.state.reason, reason);
    }
    assert.equal(stopped, reason);
    assert.equal(scheduler.pendingCount, 0);
  }
});

test("/ssh-exit style cancel prevents a scheduled or in-flight retry", async () => {
  const scheduler = new FakeReconnectScheduler();
  let started = 0;
  const supervisor = new ReconnectSupervisor({
    getPolicy: () => noJitter,
    scheduler,
    connect: async (signal) => {
      started += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 0);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("SSH connection cancelled"));
        });
      });
    },
  });

  supervisor.notifyUnexpectedLoss();
  supervisor.cancel("user-exit");
  await scheduler.advance(5_000);
  assert.equal(started, 0);
  assert.equal(supervisor.state.kind, "cancelled");
  if (supervisor.state.kind === "cancelled") {
    assert.equal(supervisor.state.reason, "user-exit");
  }

  const inFlight = new ReconnectSupervisor({
    getPolicy: () => ({ ...noJitter, initialDelayMs: 0 }),
    scheduler,
    connect: async (signal) => {
      started += 1;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("SSH connection cancelled"));
        });
      });
    },
  });
  inFlight.notifyUnexpectedLoss();
  await scheduler.advance(0);
  assert.equal(inFlight.state.kind, "attempting");
  inFlight.cancel("user-exit");
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(inFlight.state.kind, "cancelled");
  if (inFlight.state.kind === "cancelled") {
    assert.equal(inFlight.state.reason, "user-exit");
  }
});

test("prepareManualRetry cancels the scheduled delay and resets backoff", async () => {
  const scheduler = new FakeReconnectScheduler();
  const attempts: number[] = [];
  let remainingFailures = 1;
  const supervisor = new ReconnectSupervisor({
    getPolicy: () => noJitter,
    scheduler,
    connect: async () => {
      attempts.push(scheduler.nowMs);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("Connection refused");
      }
    },
  });

  supervisor.notifyUnexpectedLoss();
  await scheduler.advance(1_000);
  assert.deepEqual(attempts, [1_000]);
  assert.equal(supervisor.state.kind, "scheduled");
  if (supervisor.state.kind === "scheduled") {
    assert.equal(supervisor.state.delayMs, 2_000);
  }

  assert.equal(supervisor.prepareManualRetry(), "ready");
  assert.equal(scheduler.pendingCount, 0);

  remainingFailures = 1;
  supervisor.notifyUnexpectedLoss();
  assert.equal(supervisor.state.kind, "scheduled");
  if (supervisor.state.kind === "scheduled") {
    assert.equal(supervisor.state.delayMs, 1_000);
    assert.equal(supervisor.state.attempt, 1);
  }
});

test("prepareManualRetry leaves a single in-flight attempt running", async () => {
  const scheduler = new FakeReconnectScheduler();
  let releases = 0;
  let release: () => void = () => {};
  const supervisor = new ReconnectSupervisor({
    getPolicy: () => ({ ...noJitter, initialDelayMs: 0 }),
    scheduler,
    connect: async () => {
      releases += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  supervisor.notifyUnexpectedLoss();
  await scheduler.advance(0);
  assert.equal(supervisor.state.kind, "attempting");
  assert.equal(supervisor.prepareManualRetry(), "in-flight");
  assert.equal(supervisor.prepareManualRetry(), "in-flight");
  release();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases, 1);
  assert.equal(supervisor.state.kind, "idle");
});
