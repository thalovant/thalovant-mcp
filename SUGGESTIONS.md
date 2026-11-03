Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Follow-ups from the 0.7.0 chat apps tools; keep the dependency release checks.

# Follow-up

## Split `src/index.ts` by tool family

- **Problem:** `src/index.ts` holds every tool, about 3,800 lines. It is evidence for 13 parity capabilities, so the chat apps change alone refreshed 13 implementation hashes that had nothing to do with chat apps.
- **Proposal:** move each tool family's registrations into its own module, such as `src/tools/chat-apps.ts` and `src/tools/hub-skills.ts`, with shared helpers in one place. Each capability then names only the files that implement it.
- **Impact:** smaller reviews, and parity hashes that change only when that behaviour changes. Medium effort, no behaviour change.

## Print the API's `fields` names on a line of their own

- **Problem:** `apiErrorText()` (`src/api-error-output.ts`) prints every other member of an error body under the label `fields:`. A chat app refusal's own `fields` list then reads as `fields: {"detail":{..."fields":["homeserver"]}}`. Today the names are clear only because the chat app hint repeats them.
- **Proposal:** when `ThalovantApiError.fields` is non-empty, add a line such as `names: homeserver`, and rename the existing label to `body:`. That changes the shared `api-errors` evidence and its stdio assertions, so do it together with the reference.
- **Impact:** clearer errors for every tool that meets a field-level refusal. Small effort.

## Release checks

- Publish 0.7.0 only after `@thalovant/sdk` 0.10.0 is on npm and the lock resolves it. Then run the Published artifacts smoke workflow (npm, OCI, MCP Registry) before any deployment adopts the image.
- Keep bounded inputs bounded: the Zod container fix is not a general memory cap for schemas with no `.max()` constraint. The chat app inputs carry the API's own bounds: `allowed` 1-50 entries, ids of 1-255 characters, `limit` 1-500.
