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
  await expect(withRuntimeLease("held-cleanup", first, async () => "first")).rejects.toThrow("close deadline");
  let admitted = false;
  const next = withRuntimeLease("held-cleanup", clean(), async () => { admitted = true; return "second"; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(admitted).toBe(false);
  retired.resolve();
  await expect(next).resolves.toBe("second");
  expect(admitted).toBe(true);
});

it("rejects later calls without reusing an identity whose actual cleanup failed", async () => {
  const retired = deferred();
  const first = { close: () => retired.promise, waitForClosed: () => retired.promise };
  const call = withRuntimeLease("failed-cleanup", first, async () => "first");
  const rejected = expect(call).rejects.toThrow("synthetic cleanup failure");
  await new Promise(resolve => setTimeout(resolve, 0));
  retired.reject(new Error("synthetic cleanup failure"));
  await rejected;
  let admitted = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(withRuntimeLease("failed-cleanup", clean(), async () => { admitted = true; })).rejects.toThrow("identity remains unavailable");
  }
  expect(admitted).toBe(false);
});
