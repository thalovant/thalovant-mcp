Last Edit: Claude Opus 5.5 - 2026-11-07 - Motive: Close the test/http.test.ts port race; record the CodeRabbit items on #117, #120 and #122 checked against main.

# Audit

## CodeRabbit items on merged PRs #117, #120 and #122 (2026-11-07)

Checked against `main` (7a10524).

| PR | Item | Outcome |
| :--- | :--- | :--- |
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
