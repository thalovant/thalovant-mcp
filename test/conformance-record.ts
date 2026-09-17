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
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    out[vectorFile] = { digest: canonicalDigest(parsed), cases };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.writing`, JSON.stringify({ schema_version: 1, results: out }, null, 2) + "\n", "utf8");
  renameSync(`${target}.writing`, target);
}
