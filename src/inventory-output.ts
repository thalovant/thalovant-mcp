import { Inventory, Intent, Skill, friendlyTitle, languagesPresent } from "@thalovant/sdk";
import type { HubIntentInventory } from "@thalovant/sdk";

/** Add a display view without claiming catalogue metadata from runtime phrases. */
export function inventoryPresentation(runtime: HubIntentInventory, generatedAt = new Date().toISOString()) {
  const notes = [
    "Skill titles are derived from IDs; catalogue locales and hub metadata are unknown.",
    `Runtime discovery source: ${runtime.source}.`,
    ...runtime.denied.map(query => `Query refused or unanswered: ${query}.`),
    ...(!runtime.fallbacksKnown ? ["Fallback skill support is unknown."] : []),
  ];
  const inventory = new Inventory("", "", "hub", generatedAt,
    runtime.skills.map(skill => new Skill(skill.skillId, friendlyTitle(skill.skillId), [],
      skill.intents.map(intent => new Intent(intent.id, intent.name, intent.skillId, intent.engine,
        intent.phrases, intent.languages)))), notes);
  return { ...inventory.asObject(), languages_present: languagesPresent(inventory) };
}
