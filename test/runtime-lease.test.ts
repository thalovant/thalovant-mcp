import { expect, it } from "vitest";
import { withRuntimeLease } from "../src/runtime-lease.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const clean = () => ({ close: async () => {}, waitForClosed: async () => {} });

function deadline<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("test watchdog expired")), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

it("rejects an already cancelled request without constructing or reserving an identity", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private cancellation reason"));
  let created = 0;
  await expect(withRuntimeLease("pre-cancelled", () => { created += 1; return clean(); }, async () => "unused", 6000, controller.signal))
    .rejects.toMatchObject({ name: "AbortError", message: "Runtime tool request cancelled." });
  expect(created).toBe(0);
  await expect(withRuntimeLease("pre-cancelled", clean, async () => "successor")).resolves.toBe("successor");
});

it("checks cancellation again after a free identity becomes available", async () => {
  const controller = new AbortController();
  let created = false;
  const pending = withRuntimeLease("cancel-before-admission", () => { created = true; return clean(); }, async () => {}, 6000, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  expect(created).toBe(false);
  await expect(withRuntimeLease("cancel-before-admission", clean, async () => "next")).resolves.toBe("next");
});

it("cancels a caller already waiting for cleanup without releasing the identity", async () => {
  const closing = deferred();
  const cleanup = deferred();
  const controller = new AbortController();
  const first = withRuntimeLease("cancel-during-cleanup", () => ({
    close: () => { closing.resolve(); return cleanup.promise; }, waitForClosed: () => cleanup.promise,
  }), async () => "complete", 6000, controller.signal);
  await closing.promise;
  const rejected = expect(deadline(first)).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  let nextCreated = false;
  const next = withRuntimeLease("cancel-during-cleanup", () => { nextCreated = true; return clean(); }, async () => "next");
  try {
    await rejected;
    expect(nextCreated).toBe(false);
  } finally {
    cleanup.resolve();
    await Promise.allSettled([first, next]);
  }
  await expect(next).resolves.toBe("next");
});

it("removes cancelled queued work without constructing it or bypassing the active owner", async () => {
  const started = deferred();
  const work = deferred();
  const cleanup = deferred();
  let closes = 0;
  const owner = withRuntimeLease("cancelled-queue", () => ({
    close: () => { closes += 1; return cleanup.promise; }, waitForClosed: () => cleanup.promise,
  }), async () => { started.resolve(); await work.promise; });
  await started.promise;
  const controller = new AbortController();
  let created = 0;
  const cancelled = withRuntimeLease("cancelled-queue", () => { created += 1; return clean(); }, async () => "must not execute", 6000, controller.signal);
  const rejected = expect(deadline(cancelled)).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  let nextCreated = false;
  const next = withRuntimeLease("cancelled-queue", () => { nextCreated = true; return clean(); }, async () => "next");
  try {
    await rejected;
    expect(created).toBe(0);
    expect(closes).toBe(0);
    expect(nextCreated).toBe(false);
    work.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closes).toBe(1);
    expect(nextCreated).toBe(false);
  } finally {
    work.resolve(); cleanup.resolve();
    await Promise.allSettled([owner, cancelled, next]);
  }
  expect(created).toBe(0);
  await expect(next).resolves.toBe("next");
});

it("retains admitted noncancellable work and actual cleanup after caller cancellation", async () => {
  const started = deferred();
  const work = deferred();
  const cleanup = deferred();
  const controller = new AbortController();
  let closes = 0;
  const first = withRuntimeLease("cancelled-admitted", () => ({
    close: () => { closes += 1; return cleanup.promise; }, waitForClosed: () => cleanup.promise,
  }), async () => { started.resolve(); await work.promise; return "done"; }, 6000, controller.signal);
  await started.promise;
  const rejected = expect(deadline(first)).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  let nextCreated = false;
  const next = withRuntimeLease("cancelled-admitted", () => { nextCreated = true; return clean(); }, async () => "next");
  try {
    await rejected;
    expect(closes).toBe(0);
    expect(nextCreated).toBe(false);
    work.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closes).toBe(1);
    expect(nextCreated).toBe(false);
  } finally {
    work.resolve(); cleanup.resolve();
    await Promise.allSettled([first, next]);
  }
  await expect(next).resolves.toBe("next");
});

it("observes late admitted failure and preserves cleanup poisoning after cancellation", async () => {
  const started = deferred();
  const work = deferred();
  const cleanup = deferred();
  const controller = new AbortController();
  const first = withRuntimeLease("cancelled-poison", () => ({ close: () => cleanup.promise, waitForClosed: () => cleanup.promise }),
    async () => { started.resolve(); await work.promise; }, 6000, controller.signal);
  await started.promise;
  const rejected = expect(deadline(first)).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  try { await rejected; } finally {
    work.reject(new Error("late write failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
    cleanup.reject(new Error("late cleanup failure"));
    await Promise.allSettled([first]);
  }
  let created = false;
  await expect(withRuntimeLease("cancelled-poison", () => { created = true; return clean(); }, async () => {}))
    .rejects.toThrow("identity remains unavailable");
  expect(created).toBe(false);
});

it("holds the identity lease after a caller close timeout until actual cleanup", async () => {
  const retired = deferred();
  const first = { close: async () => { throw new Error("synthetic close deadline"); }, waitForClosed: () => retired.promise };
  await expect(withRuntimeLease("held-cleanup", () => first, async () => "first")).rejects.toThrow("close deadline");
  let admitted = false;
  const next = withRuntimeLease("held-cleanup", clean, async () => { admitted = true; return "second"; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(admitted).toBe(false);
  retired.resolve();
  await expect(next).resolves.toBe("second");
  expect(admitted).toBe(true);
});

it("rejects later calls without reusing an identity whose actual cleanup failed", async () => {
  const retired = deferred();
  const first = { close: () => retired.promise, waitForClosed: () => retired.promise };
  const call = withRuntimeLease("failed-cleanup", () => first, async () => "first");
  const rejected = expect(call).rejects.toThrow("synthetic cleanup failure");
  await new Promise(resolve => setTimeout(resolve, 0));
  retired.reject(new Error("synthetic cleanup failure"));
  await rejected;
  let admitted = false;
  let created = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(withRuntimeLease("failed-cleanup", () => { created += 1; return clean(); }, async () => { admitted = true; })).rejects.toThrow("identity remains unavailable");
  }
  expect(admitted).toBe(false);
  expect(created).toBe(0);
});

it("expires queued callers without releasing the old owner or executing them later", async () => {
  const retired = deferred();
  const first = { close: async () => { throw new Error("synthetic close deadline"); }, waitForClosed: () => retired.promise };
  await expect(withRuntimeLease("queue-deadline", () => first, async () => "first")).rejects.toThrow("close deadline");
  let runs = 0;
  let closes = 0;
  const unused = { close: async () => { closes += 1; }, waitForClosed: async () => { closes += 1; } };
  const started = performance.now();
  await expect(withRuntimeLease("queue-deadline", () => unused, async () => { runs += 1; }, 20)).rejects.toThrow("acquisition deadline");
  expect(performance.now() - started).toBeLessThan(500);
  // A second expired waiter must not bypass the first abandoned barrier.
  await expect(withRuntimeLease("queue-deadline", () => unused, async () => { runs += 1; }, 20)).rejects.toThrow("acquisition deadline");
  expect(runs).toBe(0);
  expect(closes).toBe(0);
  let admitted = false;
  const next = withRuntimeLease("queue-deadline", clean, async () => { admitted = true; return "after cleanup"; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(admitted).toBe(false);
  retired.resolve();
  await expect(next).resolves.toBe("after cleanup");
  expect(runs).toBe(0);
  expect(closes).toBe(0);
});

it("serializes successful tool work until the preceding cleanup completes", async () => {
  const work = deferred();
  const retired = deferred();
  let secondRan = false;
  const first = withRuntimeLease("normal-serialization", () => ({ close: () => retired.promise, waitForClosed: () => retired.promise }), async () => { await work.promise; return "first"; });
  const second = withRuntimeLease("normal-serialization", clean, async () => { secondRan = true; return "second"; });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(secondRan).toBe(false);
  work.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(secondRan).toBe(false);
  retired.resolve();
  await expect(first).resolves.toBe("first");
  await expect(second).resolves.toBe("second");
});
