Last Edit: Claude Sonnet 5.5 - 2026-11-12 - Motive: CodeRabbit round 3 on PR 128: malformed 2xx announcement/cancel/read answers, cancelled with no hub_confirmed, pending delivery results, strict rate-limit integers, audit never hides a sent announcement, the confirmation prompt is not written to the event-store file, 24-hour key wording, FAQ/README wording.

# Follow-up

## Intercom: know the token's scopes, not only a sign-in's

- **Problem:** the `intercom:urgent` check (`grantedScopes`, `src/index.ts`) works only for a token minted by this server's own sign-in; for a token in `THALOVANT_API_TOKEN` the scopes are invisible, so the API's `403 urgent_scope_required` is the only check, after the person was asked to confirm.
- **Proposal:** a read of the token's own scopes (`GET /v1/auth/token` or the existing token listing) once per principal, cached, or an optional `THALOVANT_API_TOKEN_SCOPES` the operator declares.
- **Impact:** low effort; avoids one needless confirmation prompt per refused urgent announcement.

## Intercom: take the SDK's methods and add the list tool (0.9.0)

- **Problem:** `src/intercom-sdk.ts` calls the Intercom routes directly (four functions: speakers, one announcement, announce, cancel) because `@thalovant/sdk` has not published its intercom methods. A second copy of request and error handling is a drift risk. Also, after an unreachable API an agent has no way to find an announcement whose id it never received.
- **Proposal:** when the SDK ships `announce`, `getAnnouncement`, `cancelAnnouncement` and `listIntercomSpeakers`, replace the four functions and delete the fetch code (check the SDK's `announce` sends one request, no retry, and rejects dot-segment ids). Add `thalovant_intercom_list_announcements` (`GET /announcements?limit&cursor`, `intercom:read`, read-only) so the "read it first" advice can be followed without an id.
- **Impact:** small; one file and one read tool (64 -> 65 default tools, 30 -> 31 read-only).

## Intercom: require a hub allowlist when the announce opt-in is on

- **Problem:** the review (M6) asked for `THALOVANT_INTERCOM_ALLOWED_HUBS` to be required when `THALOVANT_ENABLE_INTERCOM_ANNOUNCE` is on and to fail closed when empty. Contract section J keeps it optional (unset = any hub the token reaches), so a token with several hubs (family, rental) can still be steered to another hub by an injected instruction, short of the person's confirmation for urgent and `allowAll`.
- **Proposal:** a stricter mode, for example `THALOVANT_INTERCOM_REQUIRE_HUB_ALLOWLIST=1`, or a startup warning in `thalovant_config_status` when the opt-in is on and the list is unset.
- **Impact:** small; one env switch and one test; a product decision for the contract owner.

## Intercom: show the confirmation text only on request

- **Problem:** the confirmation prompt shows the person the announcement text so they can see what will be said. It goes to the MCP client's UI, which already holds the tool call, but it is one more place the text appears. Over Streamable HTTP the transport also keeps the prompt in its in-memory resumption buffer (up to 200 events per stream, for the life of the process); since this round it is no longer written to the file-backed `MCP_EVENT_STORE_FILE` (`FileEventStore.storeEvent`, `src/index.ts`).
- **Proposal:** keep it (the person cannot judge an announcement without the words); revisit only if a client is found to log elicitation prompts. If the in-memory copy matters, give the in-memory store the same skip.
- **Impact:** none today; noted for the privacy review.

## Intercom: give a refused attempt its rate-cap slot back

- **Problem:** `IntercomRateCap.consume` (`src/intercom-policy.ts`) runs just before the API call, so an attempt the API refuses outright (a `429 intercom_urgent_busy`, a 403 for a missing `intercom:urgent`, a 409) still counts against this server's own cap (5 urgent an hour by default), and cancelling the running announcement does not give it back. After a busy refusal the next urgent attempt can be refused locally for up to an hour. The error hints now say so; the accounting is unchanged.
- **Proposal:** a `release(principal, priority)` on `IntercomRateCap` that removes the most recent timestamp, called only after a definitive no-send refusal (a `ThalovantApiError` with a 4xx status other than 408; never after a 5xx, an unreachable API or a malformed success, which may have been spoken).
- **Impact:** small (one method, one call site, two tests); a product decision, because it makes the cap count announcements rather than attempts, and an agent could then hammer a busy hub (the API's own per-hub limits still apply).

## Intercom: write the audit intent before an announcement goes out

- **Problem:** the audit record of an announcement is written after the API answered. A log that cannot be written no longer hides the answer (`auditLogBestEffort`, `src/index.ts`: stderr `mcp.audit_failed`), but an operator who treats the audit log as mandatory would then have an announcement with no record.
- **Proposal:** an opt-in (for example `THALOVANT_INTERCOM_AUDIT_REQUIRED=1`) that writes an `mcp.intercom.announce_intent` record (ids, digest, targets, priority; no text) before `intercomAnnounce`, and refuses to send when that write fails; the outcome record stays best-effort.
- **Impact:** small; one env switch, one extra line per announcement when on, and two tests; nothing changes for operators who leave the audit log off.

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
