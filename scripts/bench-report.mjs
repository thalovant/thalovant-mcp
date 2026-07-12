import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function summarizeDurations(durations, maxP95Ms) {
  if (!Array.isArray(durations) || durations.length === 0) {
    throw new Error("benchmark requires at least one duration");
  }
  if (!Number.isFinite(maxP95Ms) || maxP95Ms <= 0) {
    throw new Error("benchmark max p95 must be positive");
  }
  const sorted = durations.toSorted((a, b) => a - b);
  const sum = durations.reduce((total, value) => total + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  const p95Ms = Number(sorted[p95Index].toFixed(2));
  return {
    runs: durations.length,
    minMs: Number(sorted[0].toFixed(2)),
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
    p95Ms,
    maxMs: Number(sorted.at(-1).toFixed(2)),
    meanMs: Number((sum / durations.length).toFixed(2)),
    maxP95Ms,
    passed: p95Ms <= maxP95Ms,
  };
}

export async function publishBenchmark(result) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  console.error(serialized.trimEnd());
  const output = String(process.env.BENCH_OUTPUT || "").trim();
  if (output) {
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, serialized);
  }
  if (!result.passed) {
    process.exitCode = 1;
  }
}
