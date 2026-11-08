Last Edit: Claude Opus 5.5 - 2026-11-08 - Motive: @thalovant/sdk 0.11.0 is on npm and in the lock; what is left after the rollout.

# Follow-up

## Give `interactiveLogin()` a structured prompt (Node SDK)

- **Problem:** `InteractiveLoginOptions` has no `prompt`, so a consumer that cannot print (an MCP server over stdio) learns what the person was shown indirectly: `SignInWatch` in `src/browser-login.ts` takes the consent URL from `openUrl` and a device code from the device authorization answer through the control plane's `fetch`, and the stdio entry point has to send `console.log` to stderr.
- **Proposal:** an optional `prompt` on `interactiveLogin()` that receives `{ method: "browser", url }` or `{ method: "device", grant }` and replaces the print, as `browserLogin()`'s and `loginWithBrowser()`'s already do. That is a shape change in the parity reference (Python's `interactive_login` too), so it goes through the contract.
- **Impact:** `SignInWatch` shrinks to a callback, nothing depends on the order of the SDK's calls, and the console redirect becomes a safety net only. Small in the SDKs, contract round needed.

## Export the SDK's browser opener

- **Problem:** passing `openUrl` replaces `@thalovant/sdk`'s own opener, which it does not export, so `browserCommand()` here repeats its rule.
- **Proposal:** export `openExternalUrl()` (or an `openUrl` that observes and then delegates) from `@thalovant/sdk`, and call it from `SignInWatch`.
- **Impact:** one rule for opening a URL. Small.

## After the rollout

- Done 2026-11-08: the lock's SDK entry has the published 0.11.0's `integrity` and the suite passes against it. Left: tag 0.8.0 per RELEASING.md, run the published-artifacts smoke, and update the docs.thalovant.com MCP setup and tool pages.
- Once the Python reference's `main` carries `6dfb3bb31ac7…`: drop the older digests from `reference_digests` in a separate change.

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
