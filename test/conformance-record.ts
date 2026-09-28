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
 * Set `THALOVANT_CONFORMANCE_OUT` and run the suite.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  publish(target);
}

/**
 * Written through on every record rather than at exit.
 *
 * Vitest runs test files in workers, and a worker is not guaranteed to run a
 * process exit handler. Ten records is a trivial cost, and each one leaves the
 * file complete; the shard directory carries whatever other workers have
 * recorded so far.
 */
function publish(target: string): void {
  const parts = `${target}.parts`;
  mkdirSync(parts, { recursive: true });
  const mine: Record<string, Record<string, string>> = {};
  for (const [vectorFile, cases] of results) mine[vectorFile] = Object.fromEntries(cases);
  const shard = join(parts, `${process.pid}.json`);
  writeFileSync(`${shard}.writing`, JSON.stringify(mine), "utf8");
  renameSync(`${shard}.writing`, shard);
  // One worker at a time scans the shards and writes the file. Two at once
  // used to stage the same `.writing` file, so one renamed the other's away
  // (ENOENT), and a scan that ran before another worker's shard landed could
  // be renamed into place after that worker's complete one. Under the lock the
  // last publish scans after every shard is written, so the file it leaves is
  // the whole run.
  withLock(`${target}.lock`, () => merge(target, parts));
}

/** Run `work` holding a lock directory; a lock older than ten seconds is a dead worker's. */
function withLock(lock: string, work: () => void): void {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        // Released between the two calls.
      }
      if (Date.now() > deadline) throw new Error(`conformance: ${lock} stayed locked`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function merge(target: string, parts: string): void {
  const merged = new Map<string, Map<string, string>>();
  for (const name of readdirSync(parts).sort()) {
    if (!name.endsWith(".json")) continue;
    const shardBody = JSON.parse(readFileSync(join(parts, name), "utf8")) as Record<
      string,
      Record<string, string>
    >;
    for (const [vectorFile, cases] of Object.entries(shardBody)) {
      let into = merged.get(vectorFile);
      if (!into) merged.set(vectorFile, (into = new Map()));
      for (const [caseName, digest] of Object.entries(cases)) into.set(caseName, digest);
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
}
