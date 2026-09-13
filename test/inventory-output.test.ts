import { expect, test } from "vitest";
import { HubIntent, HubIntentInventory, HubSkillIntents, Inventory } from "@thalovant/sdk";
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
