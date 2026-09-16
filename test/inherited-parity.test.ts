/**
 * What this server inherits from `@thalovant/sdk`, run rather than asserted.
 *
 * MCP implements none of the conversation carry, the hive kinds or the binary
 * frames itself: it hands a session id to the SDK's `ask` and passes replies
 * back. That is a legitimate way to be on par -- but only if the version that
 * actually resolves here has the behaviour. A dependency range is not evidence;
 * these run the same shared vectors every other SDK runs, against whatever
 * `@thalovant/sdk` is installed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  BINARY_PAYLOAD_KINDS,
  binaryKindName,
  carryConversation,
  CONVERSATION_SESSION_FIELDS,
  decodeHiveBinaryFrame,
  defaultListing,
  HIVE_KINDS,
  Inventory,
  InventoryCache,
} from "@thalovant/sdk";

const vectors = (name: string) =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));

test("the SDK under this server carries a conversation as the vectors say", () => {
  const spec = vectors("conversation-vectors.json");
  for (const row of spec.cases) {
    assert.deepEqual(carryConversation(row.previous, row.session), row.expected, row.name);
  }
  assert.deepEqual([...CONVERSATION_SESSION_FIELDS].sort(), [...spec.carried_fields].sort());
  for (const field of spec.never_carried) {
    assert.ok(!(CONVERSATION_SESSION_FIELDS as readonly string[]).includes(field), field);
  }
});

test("the SDK under this server knows the hive kinds the vectors name", () => {
  const spec = vectors("mesh-vectors.json");
  assert.deepEqual([...HIVE_KINDS].sort(), [...spec.kinds].sort());
  const declared = new Set<string>([...spec.kinds, ...spec.refused_kinds]);
  const covered = new Set<string>(spec.cases.map((row: { kind: string }) => row.kind));
  for (const kind of declared) assert.ok(covered.has(kind), `${kind} is declared with no case`);
  for (const row of spec.cases) {
    assert.equal((HIVE_KINDS as readonly string[]).includes(row.kind), row.expected.accepted, row.name);
  }
});

test("the SDK under this server decodes the reference encoder's binary frames", () => {
  const spec = vectors("binary-vectors.json");
  const named: Record<string, string> = {};
  for (const [wire, name] of Object.entries(BINARY_PAYLOAD_KINDS)) named[wire] = name as string;
  assert.deepEqual(named, spec.payload_kinds);
  for (const [wire, name] of Object.entries(spec.unnamed_kind_names as Record<string, string>)) {
    assert.equal(binaryKindName(Number(wire)), name, wire);
  }
  const frames = vectors("binary-frames.json");
  for (const row of frames.cases) {
    const message = decodeHiveBinaryFrame(new Uint8Array(Buffer.from(row.frame, "base64")));
    assert.equal(message.msg_type, "bin", row.name);
    assert.equal(message.binary?.kind, row.expected_kind, row.name);
    assert.deepEqual(
      [...(message.binary?.data ?? [])],
      [...Buffer.from(row.expected_payload, "base64")],
      row.name,
    );
  }
  const bus = decodeHiveBinaryFrame(new Uint8Array(Buffer.from(frames.bus_frame, "base64")));
  assert.equal(bus.msg_type, "bus");
  assert.equal(bus.binary, undefined);
});


test("the SDK under this server answers the question vectors", () => {
  // `listing` is declared required here and its evidence named a Noise test,
  // which is how a capability passes on a filename. These are the cases.
  for (const row of vectors("question-vectors.json").cases) {
    assert.equal(defaultListing.asks(row.text, row.lang ?? undefined), row.expected,
                 `${JSON.stringify(row.text)} (${row.lang ?? "no language"})`);
  }
});

test("the SDK under this server reads an inventory as the vectors say", () => {
  const spec = vectors("inventory-vectors.json");
  assert.equal(InventoryCache.key("hub"), spec.cache_key);
  const inventory = Inventory.fromDict(spec.inventory);
  for (const row of spec.examples) {
    assert.deepEqual(inventory.intents[0].examples(row.language ?? undefined, row.limit),
                     row.expected, JSON.stringify(row));
  }
  for (const row of spec.speaks) {
    assert.equal(inventory.skills[0].speaks(row.language), row.expected, JSON.stringify(row));
  }
  assert.equal(inventory.skills[1].speaks("en"), undefined);
});
