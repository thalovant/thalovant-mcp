import { describe, expect, it } from "vitest";

import { summarizeDurations } from "../scripts/bench-report.mjs";

describe("benchmark evidence", () => {
  it("reports nearest-rank p95 and passes at the boundary", () => {
    expect(summarizeDurations([100, 200, 300, 400, 500], 500)).toEqual({
      runs: 5,
      minMs: 100,
      medianMs: 300,
      p95Ms: 500,
      maxMs: 500,
      meanMs: 300,
      maxP95Ms: 500,
      passed: true,
    });
  });

  it("fails a p95 regression and rejects empty evidence", () => {
    expect(summarizeDurations([100, 200, 501], 500).passed).toBe(false);
    expect(() => summarizeDurations([], 500)).toThrow("at least one duration");
  });
});
