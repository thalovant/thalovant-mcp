/**
 * Record what the SDK under this server produced for each conformance case.
 *
 * The parity gate can check that a test *names* a vector file. It cannot check
 * that the test ran it, so it asks for the output instead: what was computed
 * for each case, compared against what the Python reference computed.
 *
 * This server implements none of these itself — it hands them to
 * `@thalovant/sdk`. That is a legitimate way to be on par, but only if the
 * version that actually resolves here behaves as the shared vectors say, which
 * is the thing a dependency range never showed.
 *
 * The digest recipe is the reference's, and two things about this language had
 * to be got right: JavaScript orders integer-like keys numerically however
 * they were inserted (`payload_kinds` is keyed "0".."15"), so the canonical
 * JSON is built by hand rather than stringified from a sorted object; and only
 * a whole number inside 2^53 is spelled the same way by every language, so
 * anything else is refused rather than recorded as a value nobody produced.
 *
 * Set `THALOVANT_CONFORMANCE_OUT` and run the suite: each worker writes what
 * it recorded to a shard of its own, and `test/conformance-global-setup.ts`
 * merges the shards into the file once, after every worker has finished.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { threadId } from "node:worker_threads";

const results = new Map<string, Map<string, string>>();

function canonicalJson(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(
        `conformance: cannot canonicalise ${value}: only whole numbers within 2^53 are ` +
          "spelled the same way in every language",
      );
    }
    return String(value);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((key) => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key]))
      .join(",") +
    "}"
  );
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * The digest of a vector file, as the reference computes it.
 *
 * A vector file may carry fractional seconds (`poll_interval_seconds: 0.01`),
 * and the reference digests the file as it parses. Python's `repr` and
 * JavaScript's `String` both write a double's shortest round-trip digits, in
 * fixed notation for magnitudes from 1e-4 up to 1e16, so inside that band the
 * spelling agrees digit for digit; outside it one writes `1e-05` and the other
 * `0.00001`, which is still refused. What a test produced goes through
 * `canonicalDigest`, which takes whole numbers alone.
 */
function vectorDigest(value: unknown): string {
  const spell = (item: unknown): string => {
    if (typeof item === "number" && !Number.isInteger(item) && Number.isFinite(item)) {
      const magnitude = Math.abs(item);
      if (magnitude >= 1e-4 && magnitude < 1e16) return String(item);
    }
    if (item === null || typeof item !== "object") return canonicalJson(item);
    if (Array.isArray(item)) return "[" + item.map(spell).join(",") + "]";
    const keys = Object.keys(item as Record<string, unknown>).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + spell((item as Record<string, unknown>)[key])).join(",") + "}";
  };
  return createHash("sha256").update(spell(value), "utf8").digest("hex");
}

/** Record what the SDK under this server produced for one case. */
export function record(vectorFile: string, name: string, produced: unknown): void {
  const target = process.env.THALOVANT_CONFORMANCE_OUT;
  if (!target) return;
  let cases = results.get(vectorFile);
  if (!cases) results.set(vectorFile, (cases = new Map()));
  const digest = canonicalDigest(produced);
  const previous = cases.get(name);
  if (previous !== undefined && previous !== digest) {
    throw new Error(`${vectorFile}/${name}: recorded twice with different outputs`);
  }
  cases.set(name, digest);
  writeShard(target);
}

/**
 * This worker's shard, written through on every record rather than at exit.
 *
 * Vitest runs test files in workers, and a worker is not guaranteed to run a
 * process exit handler. The shard is this worker's alone -- named by process
 * and thread, and staged under that name too -- so no two workers ever write
 * the same file, and nothing here reads another worker's.
 */
function writeShard(target: string): void {
  const parts = `${target}.parts`;
  mkdirSync(parts, { recursive: true });
  const mine: Record<string, Record<string, string>> = {};
  for (const [vectorFile, cases] of results) mine[vectorFile] = Object.fromEntries(cases);
  const shard = join(parts, `${process.pid}-${threadId}.json`);
  writeFileSync(`${shard}.writing`, JSON.stringify(mine), "utf8");
  renameSync(`${shard}.writing`, shard);
}

/**
 * Merge every worker's shard into `target`, once, and remove the shards.
 *
 * Run by the global setup's teardown, after all workers have finished, so the
 * scan sees every shard there will be. Merging inside the workers raced: two
 * of them staged the same file and renamed each other's away, and a merge that
 * scanned before another worker's shard landed could be renamed into place
 * after a complete one. A case two workers recorded differently is refused.
 * Written even when nothing was recorded: leaving the old file alone would let
 * a run that executed no case present an earlier run's output as its own.
 */
export function mergeShards(target: string): void {
  const parts = `${target}.parts`;
  const merged = new Map<string, Map<string, string>>();
  let names: string[] = [];
  try {
    names = readdirSync(parts).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const shardBody = JSON.parse(readFileSync(join(parts, name), "utf8")) as Record<string, Record<string, string>>;
    for (const [vectorFile, cases] of Object.entries(shardBody)) {
      let into = merged.get(vectorFile);
      if (!into) merged.set(vectorFile, (into = new Map()));
      for (const [caseName, digest] of Object.entries(cases)) {
        const previous = into.get(caseName);
        if (previous !== undefined && previous !== digest) {
          throw new Error(`${vectorFile}/${caseName}: recorded twice with different outputs`);
        }
        into.set(caseName, digest);
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const vectorFile of [...merged.keys()].sort()) {
    // The parsed JSON, not the bytes: a vendored copy is allowed to differ in
    // indentation and line endings, and the checker accepts it on the same terms.
    const parsed = JSON.parse(readFileSync(new URL(`./${vectorFile}`, import.meta.url), "utf8"));
    const cases: Record<string, string> = {};
    for (const name of [...merged.get(vectorFile)!.keys()].sort()) {
      cases[name] = merged.get(vectorFile)!.get(name)!;
    }
    out[vectorFile] = { digest: vectorDigest(parsed), cases };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.writing`, JSON.stringify({ schema_version: 1, results: out }, null, 2) + "\n", "utf8");
  renameSync(`${target}.writing`, target);
  rmSync(parts, { recursive: true, force: true });
}
