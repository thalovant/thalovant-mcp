Last Edit: Claude Opus 5.5 - 2026-11-07 - Motive: The HTTP tests' port race is fixed in the tests; keep the server-side port 0 idea as optional.

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

## Let the HTTP server listen on port 0 (optional)

- **Problem:** the port race in `test/http.test.ts` is fixed in the tests (see AUDIT.md): `startMcpHttpServer()` checks the server's own health body and retries on a fresh port after `EADDRINUSE`. The tests still pick a port before the server binds it, so a stolen port costs one extra server start.
- **Proposal:** accept `MCP_HTTP_PORT=0`. `getHttpConfig()` in `src/index.ts` reads it with a minimum of 1 and derives the default public URL and allowed hosts from it, and the startup line names the configured URL, so the server would build those from `httpServer.address()` after binding and print the bound URL; the tests would then read the port from that line.
- **Impact:** no retry at all, and a way to run several servers on one host for local work. Product change, so it waits for a release; small effort.
