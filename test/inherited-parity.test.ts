/**
 * What this server inherits from `@thalovant/sdk`, run rather than asserted.
 *
 * MCP implements none of the inventory presentation or question detection
 * itself: it hands both to the SDK. That is a legitimate way to be on par --
 * but only if the version that actually resolves here behaves as the shared
 * vectors say, and a dependency range is not evidence. `listing` used to name
 * a Noise test as its proof, which reads none of these cases.
 *
 * The conversation carry, the hive kinds and the binary frames are inherited
 * too, and their vectors are vendored beside these. They are not run here yet:
 * the exports they need arrive in @thalovant/sdk 0.8.0, and CI installs with
 * `npm ci`, which refuses a manifest the lockfile does not match. Those land
 * with the range bump.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { defaultListing, Inventory, InventoryCache } from "@thalovant/sdk";

const vectors = (name: string) =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));

test("the SDK under this server answers the question vectors", () => {
  for (const row of vectors("question-vectors.json").cases) {
    assert.equal(
      defaultListing.asks(row.text, row.lang ?? undefined),
      row.expected,
      `${JSON.stringify(row.text)} (${row.lang ?? "no language"})`,
    );
  }
});

test("the SDK under this server reads an inventory as the vectors say", () => {
  const spec = vectors("inventory-vectors.json");
  assert.equal(InventoryCache.key("hub"), spec.cache_key);
  const inventory = Inventory.fromObject(spec.inventory);
  for (const row of spec.examples) {
    assert.deepEqual(
      inventory.intents[0].examples(row.language ?? undefined, row.limit),
      row.expected,
      JSON.stringify(row),
    );
  }
  for (const row of spec.speaks) {
    assert.equal(inventory.skills[0].speaks(row.language), row.expected, JSON.stringify(row));
  }
  assert.equal(inventory.skills[1].speaks("en"), undefined);
});
