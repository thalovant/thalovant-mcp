Last Edit: Claude Sonnet 5.5 - 2026-11-12 - Motive: Intercom final API (platform security review): intercom:urgent check, new problem codes in tool errors, kind/can_play/policy_synced, replayed, the API's text rule; parity capability intercom recorded.

# Audit

## Intercom, final API (2026-11-12, 0.9.0, unreleased)

Driven by the platform security review (`CONSOLE_API_NOTES.md` section 9 of the API notes) and the final API. Evidence: `npm run typecheck`, `npm run build`, `npm test` (26 files, 710 tests passed, 34 more than the 676 before: `test/intercom.test.ts` gained the `final API`, `urgent sends` and `new problem codes` blocks, `test/intercom-output.test.ts` the text-rule and output blocks).

- **`intercom:urgent`, partly checkable.** `grantedScopes()` (`src/index.ts`) reads the scopes a sign-in was granted (`DeviceLogins.approve(principal, api, scopes)`, `src/device-login.ts`; `BrowserLogins` passes the token answer's scopes, `scopesOfToken`, `src/browser-login.ts`) and the announce handler refuses an urgent send without `intercom:urgent` before the confirmation prompt (`test/intercom.test.ts`, "refuses an urgent announcement, before the prompt and any request"). A token in `THALOVANT_API_TOKEN` carries no known scopes, so for it only the API's `403 urgent_scope_required` checks, after the prompt ("leaves the check to the API for a configured token"). Proposed in `SUGGESTIONS.md`.
- **Hints for the new codes** are in `withIntercomHint` (`src/index.ts`) and read members from the problem (`problemMember`, `problemWord`, `problemNames`): cleaned, a word of at most 40 `[A-Za-z0-9_.:-]` characters, at most five names ("keeps a hostile problem member out of the hint"). `owner_locked` and `account_locked` (403) have no hint of their own: they get the generic 403 one and the API's own sentence.
- **The text rule** (`checkAnnouncementText`, `src/intercom-output.ts`) is the API's (`app/schemas/intercom.py`, `clean_announcement_text`): NFC, the API's trim (`apiTrim`, Python's `isspace` set), Cc/Cf/Cs/Co/Zl/Zp and `<` `>` refused except the two joiners. It uses this runtime's Unicode tables and `String.prototype.normalize`, so a character assigned in a newer Unicode than the API's (or this server's) can pass in one and be refused in the other; the API's 422 is the fallback and does not echo the text.
- **`ThalovantApiError` from `@thalovant/sdk` 0.11 has no typed intercom errors** (the SDK with them is not published); the hints are chosen by `error.code` and read the other members from `error.problem`. When the SDK ships, `src/intercom-sdk.ts` can use its typed errors (`SUGGESTIONS.md`).
- Not verified against a real API, hub or MCP client UI: the tests use a loopback fake API built from the producer's notes and the API source.

## Intercom, Amendment 2 (2026-11-12, 0.9.0, unreleased)

Driven by the client-side security review (`/tmp/rt/intercom/SECURITY_REVIEW_CLIENTS.md`, MCP findings H1, M1, M6, M7, lows L1, L7, L10, and the MCP side of H2 and H3) and contract section J. Evidence: `npm run typecheck`, `npm run build`, `npm test` (26 files, 676 tests passed, 92 more than the 584 before; the Intercom ones are `test/intercom.test.ts` 53, `test/intercom-output.test.ts` 12, `test/intercom-policy.test.ts` 14, `test/bus-guard.test.ts` 34, and two in `test/http.test.ts`), `npm run test:smoke` 2, `npm run test:http` 12.

Fixed (each has tests):

- **H1, confirmation gates asserted by the model.** `thalovant_intercom_announce` now asks the person through MCP elicitation for an urgent announcement and for `allowAll` (`requireConfirmation` in `src/intercom-policy.ts`, called at `src/index.ts:3773`), showing hub, targets, priority, repeats and text, and refuses when the client cannot ask, declines, cancels, errors, or the HTTP server is in JSON-response mode (which would hang). `confirmUrgent` and `allowAll` stay as extra checks. `destructiveHint` is `true`. Tests: `test/intercom.test.ts` "Confirmation by the person", `test/http.test.ts` (Streamable HTTP, on the call's own stream; JSON-response mode refuses at once).
- **M1, `thalovant_emit_event` bypass.** `thalovant_emit_event`, `thalovant_send_action`, `thalovant_ask` and `thalovant_query` refuse any message type starting `thalovant.intercom.` and `speak` / `ovos.utterance.speak` (`src/bus-guard.ts`: `refusedBusType`, `guardRuntimeClient`). `thalovant_emit_event` checks its `eventType` before connecting (`src/index.ts:2677`); every runtime client is built through `guardRuntimeClient` (`src/index.ts:1359`), which wraps the transport's `emitBus` and `sendHiveMessage`, so the three tools that name no type are covered too and no frame leaves unguarded (an unguardable transport fails the call). Tests: `test/bus-guard.test.ts` (each tool's SDK call on a real `ThalovantClient` with a stand-in transport, all three protocols constructed, wiring), `test/intercom.test.ts` "Message types the generic runtime tools never send". `intercomGateNote` and the deny-all-four advice are gone.
- **M6, any hub, no rate cap.** `THALOVANT_INTERCOM_ALLOWED_HUBS` applies to the two reads, cancel and announce (`assertIntercomHubAllowed`, `src/intercom-policy.ts`); a per-principal sliding-window cap (`IntercomRateCap`, default 20 normal a minute and 5 urgent an hour, env-configurable) applies to announce, checked before the person is asked and counted only when the announcement goes out. Tests: `test/intercom.test.ts` "Per-principal rate cap", "Hub allowlist"; `test/intercom-policy.test.ts`.
- **M7, unsanitised labels.** Every string of an Intercom answer (names, slug, room, groups, `acked_by`, ids, times, statuses) goes through `cleanLabel` (`src/intercom-output.ts`): control, format (bidi, zero-width), separator and surrogate characters removed, white space collapsed, at most 80 code points; the answers carry a note that they are data. Characters of the API's own words in an Intercom error are cleaned too (`stripUnsafeText`, in `withIntercomHint`). Tests: `test/intercom.test.ts` "Household-supplied labels", `test/intercom-output.test.ts`.
- **H2 (MCP side), nothing could stop a repeating announcement.** `thalovant_intercom_cancel_announcement` (`src/index.ts:3676`, adapter `cancelAnnouncement` in `src/intercom-sdk.ts`), registered whenever read-only mode is off, independent of the announce opt-in; explains 409 `not_cancellable` and an answer that did not arrive; audited as `mcp.intercom.cancel`.
- **H3 (MCP side), idempotency.** A fresh UUID key per call; a caller-supplied key must be a UUID; after a 502 `hub_unreachable` the error carries the problem body's `announcement_id` (`announcementIdFromProblem`, `src/index.ts:547`) and says to read the announcement before any resend, never to retry automatically, and that the same key speaks nothing (`withIntercomHint`, `src/index.ts:566`). The call is still sent once and never retried. Tests: `test/intercom.test.ts` (502 in two body shapes, without an id, fresh keys, non-UUID keys refused).
- **L1, dot segments.** `segment()` in `src/intercom-sdk.ts` refuses empty, `.` and `..` ids; the cancel tool's `announcementId` and every `hubId` must be UUIDs. **L7, dictionary-confirmable hash.** `announcementDigest` (`src/intercom-output.ts`) is an HMAC-SHA256 (`THALOVANT_INTERCOM_AUDIT_HMAC_KEY`, else a random key of the process). **L10, audit off by default.** README, FAQ and QUICK_FACTS now say the record exists when `MCP_AUDIT_LOG` is on. **L3, L5, L6:** the MCP already refused `<` `>` and bidi in the text, kept error bodies free of echoed input (`apiErrorText`), and capped rooms, groups and the key length; unchanged.
- Wording (section J item 7): no "spoken once", no "never listens" (README, FAQ, QUICK_FACTS, CHANGELOG, `.env.example`, tool descriptions).

Known limits, documented, not fixed:

- The confirmation is only as good as the MCP client's elicitation UI: a client that auto-accepts elicitation prompts defeats it. The prompt shows the text to the person (and so to the client); the MCP client already holds the tool call, but a client that logs elicitation prompts would keep it (SUGGESTIONS.md).
- `THALOVANT_INTERCOM_ALLOWED_HUBS` is optional (contract J: unset = any hub the token reaches); the review's "required when the opt-in is on" is a suggestion (SUGGESTIONS.md).
- `guardRuntimeClient` reaches the SDK client's `transport` member, which is private in the SDK's types. The test "fails closed when the transport is not what the guard expects" constructs the real `wss`, `https` and `mqtt` clients, so an SDK upgrade that renames the members fails the build, and the call fails rather than run unguarded.
- The cancel tool and the reads are not rate-capped (they only stop or read). `thalovant_wait_for_event` may listen for any type (it sends nothing).
- Hub-side items of the review (the skill trusting `policies`, the repeat loop re-checking the flag, the API's `managed_client` refusal, the HMAC of `text_sha256`) belong to the skill and API repositories, not here.
- Not verified: against a real API and hub. The cancel route and the `announcement_id` in the 502 body are taken from the contract and the API source (`app/routes/intercom.py`), and the tests use a loopback fake; no real client UI was used to see the prompt (the tests answer it programmatically).

## Intercom (2026-11-11, 0.9.0, unreleased)

- `npm run typecheck`, `npm run build`, `npm test`: 24 files, 584 tests passed (includes `test/intercom.test.ts` and `test/intercom-output.test.ts`, 23 tests); `npm run test:smoke` 2, `npm run test:http` 10.
- Boundary: the announce tool is registered by `intercomAnnounceEnabled()` in `src/index.ts` only; `THALOVANT_MCP_READONLY` drops it even with the opt-in (`test/intercom.test.ts`, "registration").
- Known gap at that date, now closed (see Amendment 2 above): the runtime tools `thalovant_emit_event`, `thalovant_ask`, `thalovant_query` and `thalovant_send_action` could trigger the hub's intercom skill without this opt-in or its checks. They now refuse `thalovant.intercom.*` and speak message types (`src/bus-guard.ts`).
- Fixed after CodeRabbit's review of 5179dbf (each has a test in `test/intercom.test.ts`):
  - `intercomRequest()` in `src/intercom-sdk.ts` read `response.text()` outside the `try` that covers `fetch`, so an answer whose headers arrived and whose body stalled or broke off escaped as a bare error: no unreachable-API guidance and no idempotency key, although the announcement may have been spoken. The body read is now inside the same boundary (explicit cancellation still reads "cancelled").
  - `announce()` accepted an empty 2xx (`{}`) and the handler audited `sent` with no id. It now requires a string `id` and `status` and otherwise raises the unreachable-API error, so the key is shown and the audit entry says `error`.
  - `withIntercomHint()` (`src/index.ts`) dropped the key for a `502` / `hub_unreachable` and for any other 5xx of the announce call; a retry with a new key could announce twice. Both now carry it.
  - An urgent call with `repeatIntervalSeconds` but no `repeatTimes` was accepted and the interval silently dropped; it is now refused before any request.
  - Docs said "the text is never stored" unscoped; they now scope it to the platform and this server (an MCP client may keep the text in its own history), and every denylist example and the `thalovant_config_status` note name all four runtime tools.
- `confirmUrgent` is the caller's own assertion; since Amendment 2 it is only an extra check beside the person's confirmation through elicitation.
- Technical debt: `src/intercom-sdk.ts` duplicates the SDK transport rules until the SDK publishes its intercom methods (SUGGESTIONS.md).
- Privacy: the text never reaches the audit log, an error or an output (`auditArgs()`, `checkAnnouncementText()`, `announcementOutput()`; tested with `MCP_AUDIT_INCLUDE_ARGS` on and off and with a 422 that echoes the text). The text is in memory, in the request to the API, and in the MCP client's own transcript, which this server cannot control.
- Not verified: against a real API and hub. The routes exist only in the contract (`/tmp/rt/intercom/CONTRACT.md`) and in the API branch under development; the tests use a loopback fake.

## Browser sign-in (2026-11-08, 0.8.0, unreleased)

### Test evidence

Run on Node 22.23.1 with the published `@thalovant/sdk` 0.11.0 (tag v0.11.0, the merged thalovant-node-sdk#110), installed by a clean `npm ci` from the committed lock (integrity `sha512-B7nsFEar…bEb6w==`, as the registry gives it). Earlier rounds ran the same suite against the Node SDK's branch heads a7097d2, 4240239 and c438195, packed and installed with `npm install --no-save`.

| Step | Result |
| --- | --- |
| `npm run typecheck`, `npm run build` | passed |
| `npm test` | 561 passed in 22 files (`main` with 0.10.0: 387 in 20) |
| `npm run test:smoke` / `npm run test:http` | 2 / 10 passed |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm pack --dry-run` | 26 files, `dist/browser-login.js` included, no test file |
| `THALOVANT_CONFORMANCE_OUT=contracts/conformance-results.json npm test` | `browser-login-vectors.json` (sha256 `b0c73f80…9e73`, Python 39e31d8): 119 cases, every digest equal to the reference's `contracts/conformance-results.json`; the 98 cases of the first copy record unchanged results; the six other vector files unchanged |
| `check-sdk-parity.py --consumer thalovant-mcp`, Python PR head 39e31d8 (final candidate `6dfb3bb31ac7`) | verified |
| the same, Python `main` 44b6e2b | verified; reports `browser-login` as a capability the reference does not know yet (a rollout state) |
| clean `npm ci` from the committed lock | passes against the published 0.11.0; `npm audit --audit-level=high` 0 vulnerabilities |

- `test/browser-login-vectors.test.ts` runs `sign_ins` and `chooser` through the SDK and through the tools over stdio and records both under the same names; `record()` (`test/conformance-record.ts`) refuses a case recorded twice with different outputs, so the tools produced exactly what the SDK did.
- `test/browser-login.test.ts` "prints the browser prompt on stderr, never on the protocol stream…" and "prints a device login's prompt on stderr too…" drive the built server with raw JSON-RPC lines and parse every stdout line. With `keepStdoutForProtocol()` (`src/index.ts:4002`) made a no-op in `dist/index.js`, both fail; restored, both pass.
- "signs in with a device login exactly as before…" runs `--http` with `DISPLAY` set: `method: "browser"` is refused with no request, `auto` sends only `POST /v1/auth/device/authorize`, and the stand-in openers record nothing.

### Closed (CodeRabbit on #125, second review)

- `timeoutMs` was ignored by the hosted device login: `thalovant_begin_browser_login` over Streamable HTTP called `DeviceLogins.start()` without it, so a sign-in stayed pollable for the code's whole life. Fixed with a deadline in `DeviceLogins` (`timedOut()`), an `expired` answer from `thalovant_poll_device_login` once it passes, and an `expiresIn` that reports it; evidence: "over Streamable HTTP, a timeout…" in `test/browser-login.test.ts`, which fails with the check removed.
- The descriptions promised more than a device login gives, and assumed the server's loopback is the person's. Both are scoped now (see MAINTENANCE_REPORT.md); evidence: "scopes what a browser sign-in promises…".

### Open

- **Release gate, closed 2026-11-08:** `@thalovant/sdk` 0.11.0 is on npm, the lock entry carries its `integrity`, and a clean `npm ci` passes. Still open for the release itself: the tag, the published-artifacts smoke and the docs.thalovant.com pages (RELEASING.md).
- **Design debt, `SignInWatch` (`src/browser-login.ts:152`):** `InteractiveLoginOptions` has no `prompt` (Python's `interactive_login` has none either), so the server learns what was shown from the two places the SDK lets a caller in: the consent URL from `openUrl` (`:173`), and a device login's code from the device authorization answer through the control plane's `fetch` (`:180`), read with `DeviceAuthorization.fromGrant()`. It depends on the SDK passing the consent page to `openUrl` (it does while `openBrowser` is true, which the server never changes) and on the device answer arriving before that page is handed over (it must: the page is in the answer). See SUGGESTIONS.md.
- **Own opener (`browserCommand()`, `src/browser-login.ts:96`):** passing `openUrl` replaces the SDK's opener, which `@thalovant/sdk` does not export, so the server carries a copy of its rule (`open --`, `rundll32 url.dll,FileProtocolHandler`, `xdg-open`; one argument; http(s) without credentials or whitespace). macOS and Windows are checked only through the platform preload (`test/platform-preload.mjs`) and stand-in scripts on Linux.
- **Minor:** a browser sign-in that is approved but never polled is used at once (`BrowserLogins.start`, `:250`, calls the approval hook when the SDK resolves), because its token is already minted; its outcome is forgotten after the wait plus 5 minutes (`OUTCOME_GRACE_MS`, `:71`). Device sign-ins keep their behaviour (approved on the poll).
- **Not run here:** Node 20 and 24 (CI's matrix); a real browser; a real API with thalovant-api #501 deployed.

## CodeRabbit items on merged PRs #29, #30, #82, #117, #120 and #122 (2026-11-07)

Checked against `main` (7a10524). The six review-body items on #29 and #30 still hold as MAINTENANCE_REPORT.md recorded them on 2026-11-03 (all fixed in 084bcd9, #58); the last of them, the two bare calls in "URL-encodes the skill name in the path", went through `callToolSuccessfully` in 767261c (#117).

| PR | Item | Outcome |
| :--- | :--- | :--- |
| #82 | Serialize the shared conformance publication (`test/conformance-record.ts:96-123`, review body) | Fixed later, in 2e161cb (#92): workers only write their own shard (`record()`, named by process and thread), and `mergeShards()` runs once from the Vitest global setup's teardown (`test/conformance-global-setup.ts`) after every worker has finished, so no scan can miss a shard still being written. Nothing else calls it. |
| #117 | Name the report and audit files in the verification scope (`MAINTENANCE_REPORT.md`, review body) | Fixed before the merge, in the PR's third commit (squash 767261c): the line reads "Test, contract and report files only (AUDIT.md, MAINTENANCE_REPORT.md)". |
| #120 | Refresh the `test/runtime-noise.test.ts` evidence digest for `listing` and `runtime` | Fixed before the merge (squash 1bed882): both entries read `edf844cb...`, the file's hash; `check-sdk-parity.py --consumer thalovant-mcp` verifies. |
| #120 | Do not list the 90 s budget under the published 0.7.1 (`CHANGELOG.md`) | Still valid until now: the `v0.7.1` tag peels to fa21749, whose `test/runtime-noise.test.ts` has 30 s, yet the 0.7.1 entry listed the budget. The tag was never moved. The bullet now sits under 0.7.2, the first tag that has it (`git merge-base --is-ancestor 1bed882 v0.7.2`). |
| #122 | Record the merge, tag and artifact checks as pending, then add the evidence (`MAINTENANCE_REPORT.md`) | Fixed before the merge (squash 356ec8f): the entry says they were pending. The evidence was posted on #122 after the release and is now in the 0.7.2 entry of MAINTENANCE_REPORT.md. |

## Store refusals by code (2026-11-07, 0.7.2)

- **Closed:** a 409 `skill_unavailable_unpublished` (thalovant-api#495) or any `skill_unavailable_*` code other than licensing fell through `controlPlaneErrorHint` (`src/index.ts`) to the generic 409 hint, which tells the caller the skill is already installed at that version and to POST a different one: wrong advice for a skill nothing can install. Evidence: the three `skill_unavailable` tests in `test/provisioning.test.ts` assert the new hints and that the version text is absent; `npm test` 386/386, `test:smoke` 2/2, `test:http` 9/9.
- **Open, minor:** `LICENSING_HINT_409` says `thalovant_list_marketplace_skills` reports the refusal per skill; that is true for an admin's token only, as the API leaves unavailable rows out for everyone else. Left as it is; the unpublished hint says it plainly.

## Test port race in the HTTP shutdown tests (2026-11-07)

- **Closed (2026-11-07, Unreleased):** every test in `test/http.test.ts` now starts the server through `startMcpHttpServer()`, which accepts only the server's own health body (`name: "thalovant"`, `transport: "streamable-http"`) from a child that is still running, and starts a child that exited on `EADDRINUSE` again on a fresh port (three tries). Evidence: the new test "moves to a fresh port when another loopback server takes the freed one" hands the helper a port a fake API answering `{ ok: true, path }` already holds; it passes, and the fake sees only `/healthz` probes. With the old rule (any 200 is healthy) put back in a scratch copy, the same test fails (`expected 41361 not to be 41361`): the helper took the fake's port, as CI run 42420904832 did. `npm test` 387/387, `test:http` 10/10, `test:smoke` 2/2. The release workflow's `npm test` runs the same file, so a release run can no longer fail this way. `scripts/bench-http.mjs` keeps its own `freePort()`; it runs alone, not beside other servers.
- **Was open, flaky test:** `freePort()` in `test/http.test.ts` binds port 0, reads the port and closes it before `spawnHttpServer` starts the server on it. Vitest runs files in parallel, and the fake control planes in `test/provisioning.test.ts` and `test/security-hardening.test.ts` also listen on port 0 and answer every path with `{ ok: true, path }`. When one of them takes the freed port first, `waitForHealth` sees a 200 from it and the MCP client talks to the fake API. Evidence: CI run 42420904832 (`main`, cacfb4a, Node 20) failed "closes an active MCP session and exits cleanly on SIGINT" with a `ZodError` naming the unrecognized keys `ok` and `path`; the same tree passed on the pull request and on Node 22 and 24. No product code is involved. See SUGGESTIONS.md.

## 0.7.0 chat apps tools (2026-11-03)

### Test evidence

Run from a clean `npm ci` against the published `@thalovant/sdk` 0.10.0, resolved from the npm registry by the lock.

| Step | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `npm test`, 2 workers | 381 tests passed in 20 files; `main` had 310 in 18 |
| `npm run test:smoke` | 2 passed |
| `npm run test:http` | 9 passed |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Conformance (`THALOVANT_CONFORMANCE_OUT`) | structurally identical to `contracts/conformance-results.json` |

The new tests are in three files:

- [test/chat-apps-output.test.ts](test/chat-apps-output.test.ts) has 42 unit tests.
- [test/chat-apps.test.ts](test/chat-apps.test.ts) has 28 stdio tests against the built server and a loopback API.
- [test/http.test.ts](test/http.test.ts) has one Streamable HTTP test with a principal's own credential.

### Findings

1. **Credential boundary (by design).** No chat app tool takes a token or secret, so `createBridge`, `replaceBridgeToken` and `replaceBridgeSecrets` have no tool. The console does them.
   - Evidence: [test/chat-apps.test.ts](test/chat-apps.test.ts) "takes no token or secret in any chat app tool" (line 212) checks every chat app tool's input properties.
   - `thalovant_update_bridge` refuses a setting whose name looks like a credential, at any depth, before any request ([src/index.ts](src/index.ts) line 3328). The refusal names the setting, never its value: test "refuses an empty change ..." (line 494).
2. **Platform-only status fields are dropped.** An administrator's token receives `status.message` and `status.operator_reason`. `bridgeView()` ([src/chat-apps-output.ts](src/chat-apps-output.ts) line 172) builds the output from the documented members and leaves both out. Test "lists bridges with the status in words, never the platform's message or a credential" (line 320) sends both, plus a stray `token`, and asserts none appears.
3. **Key-name redaction hides non-secret names (tech debt).** `redactSecrets()` ([src/index.ts](src/index.ts) line 917) redacts any member whose name contains `secret` or `token`. That would turn a bridge's `secrets_set` and `token_updated_at`, and a connector's `secrets` list, into `[redacted]`, though they hold names and a time. The chat app views are allowlisted instead, and only `settings` and `operation` go through redaction. A future pass of `redactSecrets()` over a whole view would hide those names again.
4. **`fields` label collision.** `apiErrorText()` ([src/api-error-output.ts](src/api-error-output.ts) line 68) prints the rest of an error body under `fields:`. A refusal's own `fields` list then appears as `fields: {"detail":{..."fields":["homeserver"]}}`. `bridgeErrorHint()` repeats the names in words: test "names the settings a refusal is about, never their values" (line 516). Not changed here, because `api-error-output.ts` is shared `api-errors` evidence; see [SUGGESTIONS.md](SUGGESTIONS.md).
5. **Name heuristic for credential-looking settings.** `isSecretKeyName()` ([src/index.ts](src/index.ts) line 912) reuses `SECRET_KEYS`, so a future setting named, for example, `token_endpoint` or `certificate_url` would be refused locally. Today's connector settings (`homeserver`, `user_id`, `url`, `bot_login`, `client_id`) do not match.
6. **Parity evidence churn.** `src/index.ts` (3,757 lines) is implementation evidence for 13 capabilities besides `chat-apps`, so this change refreshed all 13 hashes without changing their behaviour. The conformance results above are unchanged.
7. **Delete is not idempotent.** `thalovant_delete_bridge` answers the API's 404 on a second call, with the not-visible hint; it is annotated `idempotentHint: false`. It is registered only with `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS`: test "deletes a bridge only when destructive tools are enabled" (line 554).
8. **Listing chats needs a write scope (corrected).** The API serves `GET /v1/bridges/{id}/chats` only to `hubs:write`, the hub's owner or a manager, and a paid owner, because it asks the chat network. The first draft documented it as `hubs:read`. It changes nothing (Telegram is read without acknowledging updates), so `thalovant_list_bridge_chats` keeps `readOnlyHint: true`. `WRITE_SCOPE_READ_TOOLS` in [src/index.ts](src/index.ts) leaves it out of `THALOVANT_MCP_READONLY` mode, whose token would be refused. Tests: "keeps only the chat app reads a hubs:read token can call in read-only mode" and "says which scope each chat app tool needs" in [test/chat-apps.test.ts](test/chat-apps.test.ts).
9. **Release blocker (resolved).** The first drafts asked for `@thalovant/sdk` ^0.9.9, whose published versions have no chat app methods, so hosted CI failed its typecheck. `package.json` and the lock now ask for ^0.10.0, resolved from npm.

## 0.6.6 dependency security audit

### Primary Sources

- [body-parser GHSA-27r3-jxmh-p828](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828): CVE-2026-111181 is fixed in 2.4.0, now locked. Express's declared range accepts it.
- [Zod 4.6.6 release](https://github.com/colinhacks/zod/releases/tag/v4.6.6): fixes bounded array/set/map size validation before element parsing. This patch locks 4.6.7; the MCP SDK declares Zod 4 support. No incompatible transitive override.
- [fast-uri 3.1.9 release](https://github.com/fastify/fast-uri/releases/tag/v3.1.9): fixes scheme/host/path normalization issues. The existing override moves from 3.1.8 to 3.1.9.

No scanner suppression or policy exception is added. Version-floor tests are regression guards, not a substitute for future advisory scans. Zod's fixed early bound check only helps schemas with a declared bound; this change does not claim all unbounded input is safe.

### Compatibility

Compared the public `tools/list` catalogs from the previous 0.6.5 build and the patched build using credential-free local stdio clients. Both list 50 default tools. The five record schemas retain string keys and their prior value types. Zod 4's serializer adds `propertyNames`, inlines repeated records and emits `{}` instead of `true` for passthrough objects. It omits `additionalProperties: false` for stripping objects; runtime parsing still strips unknown keys. UUID schemas now add an RFC version/variant pattern (plus nil/max UUIDs), and memory-list `offset` gains the safe-integer maximum 9007199254740991. Validation errors can use Zod 4 wording.

Regression coverage exercises the actual stdio catalog, invalid slot values and unsafe offsets, plus direct bounded-array early rejection and stripping-map semantics. Existing HTTP authentication, transport, cancellation, runtime and SDK conformance tests remain enabled. No public API endpoints, permissions or legal/mobile release settings change.

### Verification Boundary

Local install/audit reports zero vulnerabilities. Typecheck, build and all 310 tests across 18 files pass with one worker, including the real stdio and HTTP transport suites. Separate stdio smoke (2 tests) and HTTP checks (8 tests) also pass. Hosted checks and release artifact scans remain required. Earlier unrestricted parallel runs hit subprocess deadlines on the shared workstation; no timeout or assertion was weakened.

0.6.6 is prepared, not published. Before production adoption, the existing release workflow must publish matching npm/OCI/registry metadata and pass the published-artifact smoke checks. This source audit is not proof of live rollout or legal clearance.

The source-bound parity gate initially rejected the five record edits. A fresh full 310-test run with `THALOVANT_CONFORMANCE_OUT` generated results structurally identical to `contracts/conformance-results.json`. Only the existing `src/index.ts` evidence hashes were refreshed; accepted reference digests, capability declarations, tests and expected results remain unchanged. The current Python reference's parity checker then verifies the consumer record.

## Test Assertions (2026-11-03)

A provisioning test that only looks up the recorded request passes even when the tool reports an error after making it. In `test/provisioning.test.ts`, a call expected to succeed goes through `callToolSuccessfully`, which asserts `isError` is false; the "URL-encodes the skill name in the path" case now does too. A call expected to fail asserts `isError` is true, and the idempotency-key reuse case now does. The remaining direct `client.callTool` calls without an `isError` check are the `thalovant_config_status` reads, which assert on the text they return, and two pieces of the cancellation tests: the cancelled `thalovant_install_hub_skill` calls, which are asserted to reject, and the stdio-ordering barriers, whose results are not used.
