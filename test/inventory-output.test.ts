import { expect, test } from "vitest";
import { HubFallback, HubIntent, HubIntentInventory, HubSkillIntents, Inventory } from "@thalovant/sdk";
import { inventoryPresentation } from "../src/inventory-output.js";

test("display inventory uses the shared codec and preserves unknown catalogue locales", () => {
  const native = new HubIntentInventory({ languages: ["fr-fr", "en-us"], skills: [
    new HubSkillIntents("ovos-skill-weather.openvoiceos", [new HubIntent({
      skillId: "ovos-skill-weather.openvoiceos", name: "weather", engine: "padatious",
      phrases: {"fr-fr": ["météo"], "en-us": ["weather"]},
    })]),
  ], denied: ["fallbacks"], fallbacksKnown: false });
  const before = JSON.stringify(native.asObject());
  const output = inventoryPresentation(native, "2026-09-13T00:00:00Z");
  const decoded = Inventory.fromObject(output);
  expect(decoded.skills[0].title).toBe("Weather");
  expect(decoded.skills[0].speaks("en")).toBeUndefined();
  expect(decoded.hubId).toBe(""); expect(decoded.hubName).toBe("");
  expect(decoded.intents[0].examples(undefined, 0)).toEqual(["météo"]);
  expect(output.languages_present).toEqual(["en-us", "fr-fr"]);
  expect(decoded.notes).toContain("Fallback skill support is unknown.");
  expect(decoded.notes).toContain("Query refused or unanswered: fallbacks.");
  expect(JSON.stringify(native.asObject())).toBe(before);
});

test("empty runtime result retains uncertainty and never invents supported locales", () => {
  const output = inventoryPresentation(new HubIntentInventory({languages: ["en-us"], skills: []}));
  expect(output.skills).toEqual([]); expect(output.languages_present).toEqual([]);
  expect(output.notes).toContain("Fallback skill support is unknown.");
});

test("notes say which language the sentences are in when the hub listed another", () => {
  const output = inventoryPresentation(new HubIntentInventory({
    languages: ["ja-JP", "en-us"], listedIn: ["en-US", "en-us"], skills: [],
    fallbacks: [new HubFallback("test.llm")], fallbacksKnown: true,
  }));
  expect(output.notes).toContain("Sentences for ja-JP are listed in en-US: the hub has none under ja-JP.");
  expect(output.notes.filter((note: string) => note.startsWith("Sentences for"))).toHaveLength(1);
  expect(output.notes).toContain("Fallback skills are in skill id order; the hub does not say in which order it tries them.");
});
