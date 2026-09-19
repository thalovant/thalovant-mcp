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
 * the same way, and now run here too. The exports they need arrived in
 * @thalovant/sdk 0.8.0 and the range bump has landed, so `npm ci` resolves a
 * version that has them.
 *
 * These three also record what they produced, because naming a vector was
 * never evidence that it ran. `binary-frames.json` is vendored beside the
 * vectors: it is hivemind-bus-client's own encoder output, so the frames
 * decoded here are the wire a hub really puts out rather than bytes this
 * repository built for itself. (`encodeHiveBinaryFrame` refuses to build one,
 * deliberately -- it would drop `binary.data`.)
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
  failureError,
  HIVE_KINDS,
  Inventory,
  InventoryCache,
  refusalBelongsToAsk,
  ThalovantEvent,
  ThalovantPolicyDeniedError,
  ThalovantUnansweredError,
  UNTRACKED_UTTERANCE_GRACE_MS,
} from "@thalovant/sdk";

import { record } from "./conformance-record.js";

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

test("the SDK under this server carries a conversation as the vectors say", () => {
  const spec = vectors("conversation-vectors.json");
  for (const row of spec.cases) {
    const carried = carryConversation(row.previous, row.session);
    // Recorded before the assert: what the SDK produced, not a restatement of
    // what the vector says it should have.
    record("conversation-vectors.json", row.name, carried);
    assert.deepEqual(carried, row.expected, row.name);
  }
  assert.deepEqual([...CONVERSATION_SESSION_FIELDS].sort(), [...spec.carried_fields].sort());
  for (const field of spec.never_carried) {
    // A remembered `lang` would pin a bilingual conversation to whichever
    // language it opened in, which is the failure that list prevents.
    assert.ok(!(CONVERSATION_SESSION_FIELDS as readonly string[]).includes(field), field);
  }
});

test("the SDK under this server names the hive kinds as the vectors say", () => {
  const spec = vectors("mesh-vectors.json");
  assert.deepEqual([...HIVE_KINDS].sort(), [...spec.kinds].sort());
  for (const kind of spec.refused_kinds) {
    assert.ok(!(HIVE_KINDS as readonly string[]).includes(kind), kind);
  }
});

test("the SDK under this server decodes the reference encoder's binary frames", () => {
  const spec = vectors("binary-vectors.json");
  const frames = vectors("binary-frames.json");

  const named: Record<string, string> = {};
  for (const [wire, name] of Object.entries(BINARY_PAYLOAD_KINDS)) named[wire] = name as string;
  assert.deepEqual(named, spec.payload_kinds);
  for (const [wire, name] of Object.entries(spec.unnamed_kind_names as Record<string, string>)) {
    assert.equal(binaryKindName(Number(wire)), name, wire);
  }

  for (const row of spec.cases) {
    const carrier = frames.cases.find((one: { name: string }) => one.name === row.name);
    assert.ok(carrier, `${row.name}: the vectors describe a case the frames do not carry`);
    const message = decodeHiveBinaryFrame(new Uint8Array(Buffer.from(carrier.frame, "base64")));
    const binary = message.binary!;
    // Recorded before the assert, for the same reason as the carry. `file_name`
    // is the wire spelling the reference records under; `fileName` is only how
    // this language spells it.
    record("binary-vectors.json", row.name, {
      kind: binary.kind,
      utterance: binary.utterance,
      lang: binary.lang,
      file_name: binary.fileName,
    });
    assert.equal(binary.kind, row.expected.kind, row.name);
    assert.equal(binary.utterance, row.expected.utterance, row.name);
    assert.equal(binary.lang, row.expected.lang, row.name);
    assert.equal(binary.fileName, row.expected.file_name, row.name);
  }
});

test("the SDK under this server ends a refused ask the way the vectors say", () => {
  const spec = vectors("refusal-vectors.json");
  for (const one of spec.classification) {
    // A real ThalovantEvent, not a shape that looks like one: `text` is a
    // getter over the wire's several spellings, and a plain object has none.
    const event = new ThalovantEvent(one.event.type, one.event.data ?? {}, one.event.context ?? {});
    const error = failureError(event);
    if (one.expect.kind === "unanswered") {
      assert.ok(error instanceof ThalovantUnansweredError, one.name);
      assert.equal((error as InstanceType<typeof ThalovantUnansweredError>).said, one.expect.said, one.name);
      record("refusal-vectors.json", one.name, { kind: "unanswered", said: one.expect.said });
      continue;
    }
    assert.ok(error instanceof ThalovantPolicyDeniedError, one.name);
    const refused = error as InstanceType<typeof ThalovantPolicyDeniedError>;
    const produced = {
      kind: "refused",
      denied_type: refused.deniedType,
      code: refused.code,
      reason: refused.reason,
      allowed: refused.allowed,
      quota: refused.quota
        ? {
            period: refused.quota.period,
            limit: refused.quota.limit,
            used: refused.quota.used,
            reset_after: refused.quota.resetAfter,
          }
        : null,
    };
    // Recorded before the assert, as the carry and the frames are: what this
    // produced is the evidence, and a case that threw would otherwise record
    // nothing at all.
    record("refusal-vectors.json", one.name, produced);
    assert.deepEqual(produced, one.expect, one.name);
  }

  for (const one of spec.correlation) {
    const requestId = one.request_id === null
      ? undefined
      : one.request_id === "own" ? "req-own" : "req-other";
    assert.equal(
      refusalBelongsToAsk({
        requestId,
        ownRequestId: "req-own",
        deniedType: one.denied_type,
        asksInFlight: one.asks_in_flight,
        queriesInFlight: one.queries_in_flight,
        sendsInFlight: one.sends_in_flight,
      }),
      one.taken,
      one.name,
    );
  }

  assert.equal(UNTRACKED_UTTERANCE_GRACE_MS, spec.untracked_grace_seconds * 1000);
});
