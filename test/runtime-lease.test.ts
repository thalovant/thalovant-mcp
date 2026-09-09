import { expect, it } from "vitest";
import { withRuntimeLease } from "../src/runtime-lease.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const clean = () => ({ close: async () => {}, waitForClosed: async () => {} });

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
