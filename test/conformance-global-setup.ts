/**
 * Conformance recording's bookends, for Vitest's global setup.
 *
 * Before any worker starts, shards an earlier run left behind are removed, so
 * they cannot be counted as this run's output. After every worker has
 * finished, the shards are merged into `THALOVANT_CONFORMANCE_OUT` once (see
 * `mergeShards` in ./conformance-record.ts). Without the variable, nothing
 * happens.
 */
import { resolve } from "node:path";
import { rmSync } from "node:fs";

import { mergeShards } from "./conformance-record.js";

export default function setup(): (() => void) | undefined {
  const configured = process.env.THALOVANT_CONFORMANCE_OUT;
  if (!configured) return undefined;
  // Resolved once here and handed to the workers, so a relative path means
  // the same file to every one of them.
  const target = resolve(configured);
  process.env.THALOVANT_CONFORMANCE_OUT = target;
  rmSync(`${target}.parts`, { recursive: true, force: true });
  return () => mergeShards(target);
}
