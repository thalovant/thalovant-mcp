Last Edit: Claude Sonnet 5.5 - 2026-11-12 - Motive: Contract section J (Amendment 2), MCP items: person confirmation by elicitation, hard-blocked intercom/speak types, hub allowlist, per-principal rate cap, sanitised labels, cancel tool, 502 handling.

# Maintenance Report

## 2026-11-12 - Intercom Amendment 2 (MCP items of contract section J), 0.9.0, unreleased

Binding input: `/tmp/rt/intercom/CONTRACT.md` section J and the MCP findings of `/tmp/rt/intercom/SECURITY_REVIEW_CLIENTS.md` (H1, M1, M6, M7 and the lows that touch this repository).

**Changes**

- `src/bus-guard.ts` (new): `refusedBusType`, `assertBusTypeAllowed`, `busTypesOfFrame`, `guardRuntimeClient`. `thalovant_emit_event` refuses `thalovant.intercom.*`, `speak` and `ovos.utterance.speak` before connecting; every runtime client is built guarded, so `thalovant_ask`, `thalovant_query`, `thalovant_send_action` and `thalovant_send_code` cannot carry them either.
- `src/intercom-policy.ts` (new): `requireConfirmation` (MCP elicitation, refusing when unsupported, declined, failed or in HTTP JSON-response mode), `IntercomRateCap` and `intercomRateLimits`, `intercomHubAllowlist` and `assertIntercomHubAllowed`, `IntercomRefusal`.
- `src/intercom-output.ts`: `cleanLabel` / `stripUnsafeText` on every label and on the API's words in errors; the household-labels note; `hub_confirmed` and the cancelled wording; the audit digest is an HMAC-SHA256.
- `src/intercom-sdk.ts`: `cancelAnnouncement`, and dot-segment ids refused.
- `src/index.ts`: `thalovant_intercom_announce` (`destructiveHint: true`, confirmation, allowlist, rate cap, UUID-only keys, 502 `announcement_id` guidance, `refused` audit outcomes), new `thalovant_intercom_cancel_announcement`, allowlist on the reads, `thalovant_config_status` reports `intercomGuardrails` instead of `intercomGateNote`.
- Tool counts: 64 default, 30 read-only, 68 destructive, +1 with the Intercom opt-in (`test/provisioning.test.ts`).
- Tests: `test/intercom.test.ts` 53, `test/intercom-output.test.ts` 12, `test/intercom-policy.test.ts` 14, `test/bus-guard.test.ts` 34 (new), `test/http.test.ts` +2 (confirmation over Streamable HTTP, JSON-response mode). The announce tests that send urgent or `allowAll` now answer an elicitation prompt, and the idempotency-key tests use UUIDs.
- README, QUICK_FACTS, FAQ, CHANGELOG, AUDIT, SUGGESTIONS, docs/index.md and `.env.example` follow; wording per section J item 7. `contracts/sdk-parity.json`: evidence hashes of `src/index.ts`, `test/http.test.ts` and `test/provisioning.test.ts` refreshed in the capabilities that cite them; `reference_digests` untouched (the SDK agent supplies the Python digest).

**Verification:** `npm run typecheck`, `npm run build`, `npm test` 676 passed in 26 files (584 before), `npm run test:smoke` 2, `npm run test:http` 12.

**Transparency Report**

- AI Model: Claude Sonnet 5.5.
- Actions Taken: read the contract and the review, designed and wrote the guard, policy and output changes, the cancel tool and their tests, updated the documentation and the parity evidence hashes, and ran the suites.
- Oversight: none beyond the agent's own test runs; a human review of the confirmation wording, the guard's reach into the SDK client's `transport`, and a manual try in a real MCP client UI are still required before release.

## 2026-11-11 - CodeRabbit on 5179dbf (PR 128): Intercom

Seven inline comments and one out-of-diff note, all valid; none declined.

**Changes**

- `src/intercom-sdk.ts`: `response.text()` now sits in the `try` with `fetch`, so a stalled or broken body is an unreachable API (uncertain delivery, key shown), explicit cancellation unchanged; `announce()` requires a string `id` and `status` on a success, else the same unreachable-API error.
- `src/index.ts`: `withIntercomHint()` passes the idempotency key to the `502` / `hub_unreachable` hint and, for the announce call only, to any other 5xx; `repeatIntervalSeconds` without `repeatTimes` is refused before any request; `intercomGateNote` and the tool descriptions say all four runtime tools, and that `confirmUrgent` is the caller's assertion.
- README, FAQ, QUICK_FACTS, CHANGELOG, `.env.example`, AUDIT, SUGGESTIONS: all-four denylist example everywhere, "never stored" scoped to the platform and this server, `confirmUrgent` worded as an assertion.
- `test/intercom.test.ts`: +5 tests (502 and 5xx keys, truncated body, missing id/status in six shapes, interval without count) and the config-status and refusal tests extended; the new tests fail on the previous source.
- `contracts/sdk-parity.json`: the evidence hash of `src/index.ts` refreshed in all 15 capabilities that cite it. `check-sdk-parity.py --consumer thalovant-mcp` reports only the Python reference's unreviewed change (`src/thalovant/control.py`, `src/thalovant/intercom.py`), which is the coordinator's reference-digest step; every evidence hash in the file matches its file on disk.

**Verification:** typecheck, build, `npm test` 584 passed in 24 files, `npm run test:smoke` 2, `npm run test:http` 10.

**Transparency Report**

- AI Model: Claude Sonnet 5.5.
- Actions Taken: read CodeRabbit's review of PR 128, checked each finding against the code, fixed the code and docs above, wrote the tests, and ran them, including against the previous source to confirm the new tests fail without the fix.
- Oversight: none beyond the agent's own test runs; a human review of the error-handling change in `src/intercom-sdk.ts` and the hint wording is still required before release.

## 2026-11-11 - Intercom tools (0.9.0, unreleased)

**Changes**

- New tools `thalovant_intercom_list_speakers`, `thalovant_intercom_get_announcement` and, behind `THALOVANT_ENABLE_INTERCOM_ANNOUNCE`, `thalovant_intercom_announce` (`src/index.ts`, `src/intercom-output.ts`, `src/intercom-sdk.ts`).
- `thalovant_config_status`: `intercomAnnounceEnabled`, `intercomGateNote`. Audit: `mcp.intercom.announce` record and text-free `auditArgs()`.
- Tool counts: 63 default, 30 read-only, 67 destructive, +1 with the Intercom opt-in. Version 0.9.0 in `package.json`, `package-lock.json`, `server.json`, Dockerfile label, README.
- README, QUICK_FACTS, FAQ, CHANGELOG, AUDIT, SUGGESTIONS, docs/index.md, `.env.example` updated. Parity evidence hashes of `src/index.ts` and `test/provisioning.test.ts` refreshed (the Python reference was mid-change locally, so the parity script could not be run to completion).

**Verification:** typecheck, build, `npm test` 579 passed in 24 files.

**Transparency Report**

- AI Model: Claude Sonnet 5.5.
- Actions Taken: designed and wrote the three tools, the adapter, the output module, the tests and the documentation listed above, from the Intercom contract v1.
- Oversight: none yet beyond the agent's own test runs; a human review of the tool descriptions, the denylist guidance and the adapter is required before release.

## 2026-11-08 — CodeRabbit on d591ad3: the server's wait and the API's code

One thread, two points, both right.

**Changes**

- A device login's `timeoutMs` is the server's wait: past it the server stops polling, but the API keeps the code approvable until its own expiry. The `timeoutMs` description and both `expired` answers for a timed-out device login (`thalovant_poll_device_login`, and `thalovant_poll_browser_login` for a device login on stdio) now say that approving the code then signs nothing in here, and ask the model to tell the person not to approve it and to begin a new sign-in (`DEVICE_WAIT_OVER` in `src/index.ts`). The API's own `expired_token` answer keeps its text.
- What a poll answers once the sign-in is forgotten: README, FAQ and CHANGELOG say that `expired` lasts until the code's own expiry over Streamable HTTP and five minutes past the wait over stdio, and that a poll after that answers the tool error naming the sign-in as expired or ended. The behaviour is unchanged; only its description was missing.
- Tests: the stdio and HTTP timeout tests in `test/browser-login.test.ts` check the warning. Hashes refreshed for `src/index.ts` (15 capabilities) and `test/browser-login.test.ts`.

**Verification**

- Clean `npm ci` (published `@thalovant/sdk` 0.11.0), audit 0, typecheck, build, `npm test` 561 passed in 22 files, smoke 2, http 10; conformance re-ran to the committed file; parity verified against Python 39e31d8 and `main`.

## 2026-11-08 — Against the published `@thalovant/sdk` 0.11.0

The lead published `@thalovant/sdk` 0.11.0 (tag v0.11.0, the merged thalovant-node-sdk#110) and asked for #125 to take it from the registry.

**Changes**

- `package-lock.json`: `npm install @thalovant/sdk@^0.11.0` adds the one line that was left out, the entry's `integrity` (`sha512-B7nsFEar…bEb6w==`, the registry's `dist.integrity`). A plain `npm install` had left the lock as it was. `package.json` and every other lock entry are unchanged.
- CHANGELOG: the 0.8.0 entry is dated 2026-11-08 for the tag. AUDIT.md closes the release gate; FAQ.md, QUICK_FACTS.md and SUGGESTIONS.md follow. No source, test or parity evidence file changes, so `contracts/sdk-parity.json` is unchanged and the conformance record re-ran to the same file.

**Verification**

- Clean `npm ci` (published 0.11.0), `npm audit --audit-level=high` (0), `npm run typecheck`, `npm run build`, `npm test` (561 passed, 22 files), `npm run test:smoke` (2), `npm run test:http` (10), `npm pack --dry-run`, Node 22.23.1.
- `THALOVANT_CONFORMANCE_OUT=contracts/conformance-results.json npm test`: the file is unchanged; all 119 browser-login cases equal the Python reference's (39e31d8).
- `check-sdk-parity.py --consumer thalovant-mcp`: verified against Python 39e31d8 and against `main` 44b6e2b.
- No merge, tag or release.

### Transparency Report

- **AI Model**: Claude Opus 5.5.
- **Actions Taken**: Installed the published SDK to record its integrity, ran the validation sequence from a clean install, dated the changelog and updated these records, pushed and watched CI.
- **Oversight**: Run by an agent at the lead's request; the lead merges and releases.

## 2026-11-08 — CodeRabbit's second review of #125

Two new threads, both minor, on b8dd5f0.

**Changes**

- `timeoutMs` over Streamable HTTP (thread on QUICK_FACTS.md): it was accepted and ignored there. `DeviceLogins.start()` (`src/device-login.ts`) now takes it as a deadline beside the code's expiry, `DeviceLogins.timedOut()` reads it, and `thalovant_poll_device_login` answers `expired` without another request once it has passed; `expiresIn` in the begin answer is the shorter of the two, on stdio too (`deviceExpiresIn()` in `src/index.ts`). On stdio the SDK's own device timeout (`ThalovantTimeoutError`) now reads as `expired` (`outcomeOf()`, `src/browser-login.ts`) instead of `error`. `thalovant_begin_device_login` takes no timeout, so its sign-ins are unchanged.
- The shared loopback (thread on README.md): the begin tool's description, its `method` description, the device tool's description, README and FAQ say a browser sign-in completes only in a browser that shares the server's `127.0.0.1`, which a stdio server over SSH without port forwarding, or in a container, does not, and to use `method: "device"` there.
- What a device code allows (same thread): the browser path's promise is now scoped to the browser path in both descriptions, README and CHANGELOG, and every device answer (`thalovant_begin_browser_login` on both transports, `thalovant_begin_device_login`) says to show the code only to the person signing in, since whoever approves it signs the server in as their account.
- Tests in `test/browser-login.test.ts`: the deadline in `DeviceLogins`, `outcomeOf()` for the SDK's timeout, a stdio device login and an HTTP one each given 1000 ms (`expiresIn: 1`, then `expired`, and over HTTP no token poll after the deadline), and the descriptions. With the HTTP deadline check taken out of `dist/index.js`, the HTTP test fails.
- `contracts/sdk-parity.json`: hashes refreshed for the changed `src/browser-login.ts`, `src/device-login.ts`, `src/index.ts` and `test/browser-login.test.ts` (20 entries); the `device-login` reason says what changes for a timed device login. Reference digests unchanged.

**Verification**

- SDK packed from a7097d2, installed with `npm install --no-save`. `npm run typecheck`, `npm run build`, `npm test` (561 passed, 22 files), `npm run test:smoke` (2), `npm run test:http` (10), Node 22.23.1. Conformance re-recorded to a scratch file: identical to the committed results.
- `check-sdk-parity.py --consumer thalovant-mcp`: verified against Python 39e31d8 and against `main` 44b6e2b.

### Transparency Report

- **AI Model**: Claude Opus 5.5.
- **Actions Taken**: Checked both findings against the code, added the device-login deadline, the consistent `expiresIn` and the timeout mapping, scoped the descriptions and docs, wrote the tests and a mutation check, refreshed the changed files' hashes, answered and resolved the threads.
- **Oversight**: Run by an agent at the lead's request; nothing merged or published.

## 2026-11-08 — Browser sign-in on the final contract; CodeRabbit on #125

The lead declared the producer final (thalovant-python-sdk#113 at 39e31d8) and the Node SDK updated to it (thalovant-node-sdk#110 at a7097d2), and asked for #125 to follow.

**Changes**

- `test/browser-login-vectors.json`: re-vendored byte for byte from Python 39e31d8 (sha256 `b0c73f808c4f26328c27dd4d04eebfbbc3e7c0c81b8d63a666f63737d0259e73`, 119 cases: 21 new in `callbacks`, `config`, `sign_ins` and `chooser`). `test/browser-login-vectors.test.ts` counts 119.
- `thalovant_begin_browser_login` accepts an empty `deviceName`, which sends no name (the consent page shows no hostname, and a device login sends no `client_name`), as the new vectors and the SDK's `deviceName ?? defaultDeviceName()` have it; omitted still means `thalovant-mcp on <hostname>`.
- Wording: the tool descriptions, README and CHANGELOG say that a link or code sent to someone on another computer delivers nothing to the sender.
- `contracts/sdk-parity.json`: the candidate `49744ee385bf…` is replaced by the final `6dfb3bb31ac7590591febef1c4d8372984ca6cdad4700381f869db30c38452df`, beside the current `57c7e71f6456…`. Hashes refreshed only for the files changed: `src/index.ts` (15 capabilities), `test/browser-login-vectors.json` and `test/browser-login-vectors.test.ts` (`browser-login`). `contracts/conformance-results.json` re-recorded.
- CodeRabbit on #125 (556dcec): `rawStdio().answer()` and `onlyProtocol()` in `test/browser-login.test.ts` read only newline-terminated stdout lines, and `onlyProtocol()` requires stdout to end on one; that file's `browser-login` hash was refreshed. The dependency thread (0.11.0 not on npm, no `integrity`) is intentional: answered on the thread and resolved.
- QUICK_FACTS, CHANGELOG, AUDIT and SUGGESTIONS name the final digest and 119 cases.

**Verification**

- Local SDK: `npm run build` and `npm pack` in the Node SDK clone at a7097d2, `npm install --no-save` of the tarball here; `package.json` and the lock left as committed.
- `npm run typecheck`, `npm run build`, `npm test` (557 passed, 22 files), `npm run test:smoke` (2), `npm run test:http` (10), Node 22.23.1.
- Conformance: 119 browser-login case digests equal the reference's; the 98 earlier cases record what they did before; the other vector files are unchanged.
- `check-sdk-parity.py --workspace … --consumer thalovant-mcp`: verified against Python 39e31d8 and against `main` (44b6e2b; `browser-login` reported as not yet known there).
- No merge, tag or release; CI stays red until `@thalovant/sdk` 0.11.0 is on npm.

### Transparency Report

- **AI Model**: Claude Opus 5.5.
- **Actions Taken**: Rebuilt and installed the Node SDK at a7097d2, re-vendored the vectors, let the begin tool take an empty device name, reworded three texts, fixed the raw-stdio line reading CodeRabbit found, re-recorded conformance, swapped the candidate digest and refreshed the changed files' hashes, answered and resolved both review threads, and updated these records.
- **Oversight**: Run by an agent at the lead's request; the owner merges after the Node SDK is published and CI passes.

## 2026-11-08 — Browser sign-in (0.8.0, unreleased)

The lead asked for this server to adopt the Node SDK's browser sign-in (thalovant-node-sdk#110, 0.11.0) as a consumer of the cross-SDK `browser-login` capability (Python reference thalovant-python-sdk#113, e3999cb): `interactiveLogin({ method: "auto" })` over stdio, device login exactly as before over the hosted transport, and the prompt kept off the stdio protocol stream.

**Changes**

- `src/browser-login.ts` (new): `SignInWatch`, `BrowserLogins`, `browserCommand()`, `openInBrowser()`, `defaultDeviceName()`, `outcomeOf()`.
- `src/index.ts`: `thalovant_begin_browser_login` and `thalovant_poll_browser_login`; `createServer({ transport })` (the CLI passes `stdio` or `streamable-http`; the default is `streamable-http`); `keepStdoutForProtocol()` on the stdio entry point; `signInControlPlane()` (was `deviceLoginControlPlane()`) takes the watch's `fetch`; `thalovant_config_status` adds `transport` and `browserLoginAvailable`; the device tool's and revoke tool's descriptions, the revoke refusal, the 401 connection hint and the unauthenticated-tool error name the browser sign-in.
- Tests: `test/browser-login-vectors.test.ts`, `test/browser-login.test.ts`, `test/browser-login-harness.ts`, `test/platform-preload.mjs` (test-only `--import` preload setting `process.platform`), `test/browser-login-vectors.json` (vendored byte for byte, sha256 `9058adf2…`); `test/provisioning.test.ts` counts 61 and 65 tools.
- `contracts/sdk-parity.json`: `reference_digests` adds the candidate `49744ee385bf…` beside the current `57c7e71f6456…`; `browser-login` is required, bound to `src/browser-login.ts`, `src/device-login.ts` and `src/index.ts` and to the test files above; the `src/index.ts` hash is refreshed in the 14 capabilities that name it, and `test/provisioning.test.ts` in `control`, because those files changed here. `contracts/conformance-results.json` is the suite's own record.
- `package.json` (0.8.0, `@thalovant/sdk` ^0.11.0), `package-lock.json` (0.8.0; the SDK entry names the registry's 0.11.0 tarball without `integrity`), `server.json`, the `Dockerfile` label, README (Browser Sign-In, tool list, SDK line, counts), CHANGELOG (0.8.0, Unreleased, with the earlier unreleased entries under it), QUICK_FACTS, FAQ, docs/index.md, AGENTS.md (two rules), AUDIT.md, SUGGESTIONS.md.

**Verification**

- Local SDK: `npm run build` and `npm pack` in the Node SDK clone (5f0cc17), then `npm install --no-save thalovant-sdk-0.11.0.tgz` here; `package.json` and the lock were left as committed.
- `npm run typecheck`, `npm run build`, `npm test` (532 passed, 22 files), `npm run test:smoke` (2), `npm run test:http` (10), `npm audit --audit-level=high` (0), `npm pack --dry-run`, Node 22.23.1. Baseline on `main` with 0.10.0: 387 passed in 20 files.
- Conformance: all 98 `browser-login-vectors.json` case digests equal the reference's; parity check verified against the Python PR head and against `main`.
- A clean `npm ci` from the committed lock fails with E404 until `@thalovant/sdk` 0.11.0 is on npm, so CI is red until then.
- No merge, tag or release.

### Transparency Report

- **AI Model**: Claude Opus 5.5.
- **Actions Taken**: Read the contract, the Python porting brief and the Node SDK implementation; wrote `src/browser-login.ts`, the two tools and the stdio console redirect in `src/index.ts`, the vector runner and behaviour tests with their harness and platform preload; built and installed the unpublished Node SDK locally; recorded conformance results; updated the parity acceptance (new capability, candidate digest, hashes of the changed files only) and these documents; opened the pull request.
- **Oversight**: Run by an agent at the lead's request. Nothing merged, tagged or published; the pull request waits for `@thalovant/sdk` 0.11.0 on npm and the normal CI gates, and the owner's merge.

## 2026-11-07 — HTTP test port race; CodeRabbit items on #29, #30, #82, #117, #120, #122

The lead asked for every open CodeRabbit item on merged pull requests to be checked against `main` (7a10524), the ones still valid fixed, and the port race recorded at 0.7.2 fixed properly, test-only.

**Changes**

- `test/http.test.ts`: `startMcpHttpServer(envFor, pickPort = freePort)` replaces `freePort()` + `spawnHttpServer()` + `waitForHealth()` in all nine tests. `waitForOwnHealth()` accepts only a 200 whose body has `name: "thalovant"` and `transport: "streamable-http"`, from a child that has not exited, and waits 100 ms between every probe (the old loop retried a non-200 at once). A child that exits on `EADDRINUSE` is replaced on a fresh port, up to three tries; any other exit, or no healthy answer within 10 s, fails with the child's stderr. Tests whose environment names the port (JWT and introspection audiences) build it per port through `envFor`.
- A new test, "moves to a fresh port when another loopback server takes the freed one": a fake API answering `{ ok: true, path }` holds the first port handed out; the session must land on another one, and the fake must see nothing but `/healthz`.
- `contracts/sdk-parity.json`: the `test/http.test.ts` evidence hash (identity, chat-apps) is refreshed. Its assertions are unchanged; the new test asserts only the startup.
- CHANGELOG: an Unreleased entry; the 0.7.1 entry's bullet for the 90 s budget of `test/runtime-noise.test.ts` moves to 0.7.2, since the `v0.7.1` tag (fa21749) has 30 s and 1bed882 is first in `v0.7.2` (CodeRabbit on #120).
- AUDIT.md closes the port race and lists the four CodeRabbit items; SUGGESTIONS.md keeps the server-side alternative (`MCP_HTTP_PORT=0`) as optional; FAQ.md answers the failure a contributor would see; the 0.7.2 entry below gets its release evidence (CodeRabbit on #122).
- No version change and no release: nothing in `dist/` changes; the corrected CHANGELOG ships with the next release.

**CodeRabbit items**

| PR | Item | Outcome |
| :--- | :--- | :--- |
| #29, #30 | Six review-body items (see 2026-11-03 below) | Still hold on 7a10524; the last two calls were fixed in 767261c (#117) |
| #82 | Serialize the shared conformance publication | Fixed in 2e161cb (#92): one merge in the global teardown |
| #117 | Verification scope should name the report files | Fixed before its merge (767261c) |
| #120 | `test/runtime-noise.test.ts` evidence digest stale | Fixed before its merge (1bed882); the parity check verifies |
| #120 | 0.7.1 entry lists a change the `v0.7.1` tag lacks | Fixed here |
| #122 | Post-merge steps written as done | Fixed before its merge (356ec8f); evidence added here |

**Verification**

- `npm ci`, `npm run typecheck`, `npm run build`, `npm test` (387 passed, 20 files), `npm run test:smoke` (2 passed), `npm run test:http` (10 passed), Node 22.23.1.
- The new test fails with the old readiness rule put back in a scratch copy (`expected 41361 not to be 41361`), and passes with the fix.
- `thalovant-python-sdk/scripts/check-sdk-parity.py --workspace <ws> --consumer thalovant-mcp` against a fresh clone of the Python SDK's `main` (bd4061f): verified.

### Transparency Report

- **AI Model**: Claude Opus 5.5.
- **Actions Taken**: Read each CodeRabbit comment and the current code; wrote the startup helper, its regression test and these notes; refreshed one parity hash; opened the pull request and answered each thread.
- **Oversight**: Run by an agent on the lead's request; the pull request goes through the normal CI gates before its merge.

## 2026-11-07 — Release 0.7.2

The owner asked for the merged `skill_unavailable_unpublished` hint (#121) to be published. Nothing else was unreleased since v0.7.1, and the change is a hint text for one more refusal code with no schema or behaviour change, so this is a patch release.

**Changes**

- `package.json`, `package-lock.json`, `server.json` (top-level version, npm package version, OCI identifier), the OCI label in `Dockerfile`, the README's SDK requirement line and QUICK_FACTS move to 0.7.2. The CHANGELOG's Unreleased entry becomes 0.7.2, dated 2026-11-07.
- AUDIT.md and SUGGESTIONS.md record a port race in `test/http.test.ts` (`freePort()` frees a port before the server takes it), which failed the Node 20 job on `main` for cacfb4a (CI run 42420904832) while the pull request and Node 22 and 24 passed. Test-only; not changed here.
- `@thalovant/sdk` stays at ^0.10.0 (the lock resolves 0.10.0, npm's latest). No source or parity evidence file changes, so `contracts/sdk-parity.json` is unchanged.

**Verification**

- `npm ci`, `npm audit --audit-level=high` (0 vulnerabilities), `npm run typecheck`, `npm run build`, `npm test`, `npm run test:smoke`, `npm run test:http`, Node 22.23.1: all pass (386 tests in 20 files, smoke 2, http 9). `package.json`, both lockfile entries and the three `server.json` fields read 0.7.2.
- Pending at the time of writing, and recorded on pull request #122 once done: the merge, the `v0.7.2` tag on the merge commit, which runs the Release workflow (npm through trusted publishing, GHCR, MCP Registry, GitHub release), and the published-artifacts smoke for 0.7.2.
- Done after the merge (added 2026-11-07, from the evidence on #122): squash-merged as 356ec8f with CI and SDK parity green on it; the annotated tag `v0.7.2` on 356ec8f ran the Release workflow (parity, npm, GHCR, both transport smokes, MCP Registry, GitHub release with the tarball and CycloneDX SBOM), which passed; npm `@thalovant/mcp-server@0.7.2` is `latest`; the MCP Registry lists 0.7.2 as latest; the published-artifacts smoke for 0.7.2 passed (npm stdio, OCI Streamable HTTP, clean PID 1 shutdown, registry metadata).

### Transparency Report

- **AI Model**: Claude Opus 5.5.
- **Actions Taken**: Bumped the aligned version files, dated the changelog entry, recorded the test port race, ran the validation sequence and opened the version pull request. The merge, the tag and the checks of npm, GHCR, the MCP Registry and the GitHub release come after this file was written; their results are on pull request #122.
- **Oversight**: Run by an agent on the repository owner's request to publish the open fixes (2026-11-08Z); the pull request goes through the normal CI gates and the CodeRabbit review before its merge.

## 2026-11-07 — Hint for a skill with no published release (0.7.2)

thalovant-api#495 (`fix/catalog-unpublished-skills`, `.changes/api-impact-catalog-unpublished-skills.yaml`) adds `unpublished` beside `licensing` as a reason the store refuses a skill, and answers an install or attach of one with 409 `skill_unavailable_unpublished` (`reason: unpublished`, a plain `detail` sentence) before any paid-plan 402. Its declaration owes this server a hint: `controlPlaneErrorHint` gave the new code the generic 409 text, which talks about a version already installed.

**Changes**

- `controlPlaneErrorHint` (`src/index.ts`) answers 409 `skill_unavailable_unpublished` with `UNPUBLISHED_HINT_409`: the skill cannot be installed because no release has been published; no plan, scope, version or retry changes that; nothing to buy; a non-admin token does not see it in `thalovant_list_marketplace_skills`; `thalovant_list_runtime_group_marketplace` lists it only for a group that already has it, with `unavailable_reason`, and `installable` and `purchase_required` false. Any other `skill_unavailable_*` code gets `SKILL_UNAVAILABLE_HINT_409`, the refusal in general terms, so a reason the API adds later never reads as a version clash. The licensing hint is unchanged.
- `thalovant_list_runtime_group_marketplace`'s description names `unavailable_reason`.
- Three tests in `test/provisioning.test.ts` ("control-plane error guidance") send the API's real problem body (`detail`, `code`, `reason` at the root) through the fake control plane: a hub install and a runtime-group install refused as unpublished, and an unknown `skill_unavailable_embargoed`.
- README (install paragraph, Tool Errors, the marketplace paragraph), CHANGELOG (an Unreleased entry), QUICK_FACTS. The parity evidence hashes of `src/index.ts` and `test/provisioning.test.ts` are refreshed.
- No version change: a version without its release breaks the infra contracts, so `package.json`, `package-lock.json`, `server.json` and the OCI label stay at 0.7.1, and the release is the owner's.

**Verification**

- `npm ci`, `npm run typecheck`, `npm run build`, `npm test` (386 passed, 20 files), `npm run test:smoke` (2 passed), `npm run test:http` (9 passed).
- `thalovant-python-sdk/scripts/check-sdk-parity.py --workspace <ws> --consumer thalovant-mcp` against a fresh clone of the Python SDK's `main` (ac5be33): verified.

### Transparency Report

- **AI Model**: Claude Opus 5.5.
- **Actions Taken**: Read thalovant-api#495's diff and impact declaration; wrote the two hints, the description clause, the three tests and these notes; refreshed the two parity hashes; opened the pull request.
- **Oversight**: Run by an agent on the repository owner's request; the pull request goes through the normal CI gates, and its merge and any release wait for the owner.

## 2026-11-06 — Refusal hints: the store's licensing refusal and the memory limit (0.7.1)

thalovant-api's launch data-protection declaration (`.changes/api-impact-launch-data-protection.yaml`, 2026-09-28) asked this server to map `skill_unavailable_licensing` on the skill-install tools, and its launch catalogue declaration asked the plan-limit hints to know the `memory_limit` code. Neither had been done: a licensing refusal got the hint about a version already installed, and the memory tools did not go through `callControlPlane` at all, so a `memory_limit` carried no hint.

**Changes**

- `controlPlaneErrorHint` answers a 409 whose code is `skill_unavailable_licensing` with its own hint (what the refusal means, that nothing the caller changes lifts it, which skills still install, where `thalovant_list_marketplace_skills` announces it), before the profile-specific 409 texts.
- A `memoryWrite` profile: `thalovant_create_memory_item` and `thalovant_update_memory_item` now run through `callControlPlane`, and the profile adds a hint for 409 `memory_limit` alone. Every other status keeps the SDK's message, because the hub-centric 403 and 402 texts would misdescribe the memory routes.
- Two tests in `test/provisioning.test.ts` ("control-plane error guidance") drive both refusals through the fake control plane and check the hint, the code in parentheses and, for the licensing case, that the version hint is gone.
- README (install paragraph, Tool Errors), CHANGELOG (0.7.1; 0.7.0 dated, it is on npm), QUICK_FACTS, `package.json`, `package-lock.json`, `server.json` and the OCI label move to 0.7.1 together. The hub and marketplace outputs already pass `listing_review_status`, `unavailable_reason` and `installable` through unchanged, so nothing else from those declarations was owed here.

**Verification**

- `npm ci` (which also replaced a stale local `node_modules` that still held an older `@thalovant/sdk`), `npm run typecheck`, `npm run build`, `npm test` (the stdio tests run the built `dist/index.js`, so the build comes first).
- The reference's `scripts/check-sdk-parity.py --workspace` passes with the refreshed evidence hashes of `src/index.ts` and `test/provisioning.test.ts`.

**Release date and the real-transport test's budget (2026-11-06, later).** The 0.7.1 entry is dated for its tag. On the merge of #119, the Node 20 job on `main` timed out in `test/runtime-noise.test.ts` (30 s); the same tree had passed that test on the pull request and on Node 22 and 24, and the rerun passed. The same timeout failed `main` on 2026-11-03, on #118's merge. The test opens eight HTTPS sessions against a local hub, each with a Noise handshake over a polled connection, and takes about 22 s on a workstation, so 30 s left a shared runner almost nothing. Its budget is now 90 s; every call keeps its own `timeoutMs` and no assertion changes.

### Transparency Report

- **AI Model**: Claude Fable 5.1.
- **Actions Taken**: Audited every SDK and the MCP against thalovant-api's impact declarations; found these two deferred items; wrote the hints, the profile, the tests and these notes; refreshed the parity evidence hashes; opened the pull request.
- **Oversight**: Run by an agent on the repository owner's request to bring the SDKs and MCP up to date with the platform's features; the pull request goes through the normal CI gates, and its merge and the 0.7.1 tag wait for the owner. The budget change was measured on the workstation (22.5 s for the test) and read from the two timed-out jobs' logs; the calls' own timeouts were left alone because shortening the asks' `timeoutMs` to 1 s made the test itself time out, which says the time goes to the sessions, not to idle waits.

## 2026-11-03 — CodeRabbit review-body items (#29, #30)

CodeRabbit's review bodies on #29 and #30 carried six "Nitpick comments", which are not threads and were never answered. Each was checked against `main` (ceb6581). All six were already fixed in 084bcd9 (#58); each old PR has a comment listing its items.

| PR | Item | Outcome |
| :--- | :--- | :--- |
| #29 | Document the restart `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS` needs | Already fixed in 084bcd9 (#58): README "Destructive Tools" |
| #29 | Unguarded `JSON.parse` in the fake control plane | Already fixed in 084bcd9 (#58): a malformed body answers 400 |
| #29 | Two copies of the fake control-plane helper | Already fixed in 084bcd9 (#58): `startFailingControlPlane` delegates to `startFakeControlPlane`, which calls `closeAllConnections()` |
| #29 | Tool calls that never assert `isError` | Already fixed in 084bcd9 (#58) via `callToolSuccessfully`; the two calls a later test added ("URL-encodes the skill name in the path") now use it too, and the idempotency-key reuse case asserts its error (CodeRabbit on this PR) |
| #30 | Positive `savePath` test | Already fixed in 084bcd9 (#58): `my-hub.json` lands in the identity directory with mode 0600 |
| #30 | List every added redaction key | Already fixed in 084bcd9 (#58): CHANGELOG 0.1.x entry names all ten |

Verification: `npm ci`, typecheck, build and the full test suite pass; the reference's `check-sdk-parity.py --consumer thalovant-mcp` passes with the refreshed `test/provisioning.test.ts` hash. Test, contract and report files only (AUDIT.md, MAINTENANCE_REPORT.md); no release.

### Transparency Report

- **AI Model**: Claude Opus 5.5.
- **Actions Taken**: Read each review-body item against current code and tests; made two test calls assert success; refreshed that file's parity evidence hash; wrote this entry and the AUDIT note; commented on #29 and #30.
- **Oversight**: Run by an agent on the repository owner's request to handle every CodeRabbit item on merged PRs; the pull request goes through the normal CI gates, and its merge waits for the lead's go.

## 2026-11-03: chat apps tools (0.7.0)

**Changes**

- **New tools.** Nine chat app tools are registered by default:
  - read-only: `thalovant_list_chat_app_connectors`, `thalovant_get_bridge_networks`, `thalovant_list_bridges`, `thalovant_get_bridge`, `thalovant_list_bridge_chats`;
  - write: `thalovant_pause_bridge`, `thalovant_resume_bridge`, `thalovant_update_bridge`, `thalovant_send_bridge_test_message`.
- **Delete.** `thalovant_delete_bridge` is opt-in with the other destructive tools.
- **Presentation.** The new `src/chat-apps-output.ts` holds the status in words, the allowlisted views and the hints by refusal code.
- **Metadata.** The version moves to 0.7.0 in `package.json`, `package-lock.json`, `server.json`, the Dockerfile label, the README and the CHANGELOG. The CHANGELOG now dates the published 0.6.6.
- **Parity.** `contracts/sdk-parity.json` declares `chat-apps` as required. It refreshes the evidence hashes of `src/index.ts`, `test/http.test.ts` and `test/provisioning.test.ts`.

**Rationale**

- Creating a bridge and replacing its token or secrets need a credential, and this server never takes a credential through tool arguments, so those stay in the console.
- Deleting follows the existing pattern for hubs, runtime groups and clients: registered only when the operator sets `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS`.
- Outputs are built from the members the API documents, so the platform-only `status.message` and `status.operator_reason` never reach a model.
- `thalovant_list_bridge_chats` changes nothing, but the API serves it only to `hubs:write` and a paid plan, because it asks the chat network. It is documented that way and left out of read-only mode.

**Verification** (clean `npm ci` against the published `@thalovant/sdk` 0.10.0):

- `npm ci`, typecheck and build pass;
- 381 tests pass in 20 files;
- smoke 2/2 and HTTP 9/9 pass;
- conformance results are identical to the committed ones;
- the parity checker verifies the record.

Details are in [AUDIT.md](AUDIT.md). `package.json` and the lock take `@thalovant/sdk` ^0.10.0 from the npm registry.

### Transparency Report

- **AI Model:** Claude Opus 5.5 (claude-opus-5-5).
- **Actions Taken:**
  - designed the tool set and the credential and delete decisions;
  - wrote `src/chat-apps-output.ts`, the tool registrations in `src/index.ts`, and the unit, stdio and HTTP tests;
  - updated the README, docs index, CHANGELOG, version files, parity record and these files.
- **Oversight:** automated tests (above) and CodeRabbit review on the pull request. A lead agent delegated by the repository owner merges and releases.

## 2026-10-25: dependency security patch (0.6.6)

Updated the body-parser lock entry, the direct Zod range and the existing fast-uri override. Migrated five string-keyed records, added dependency floors and bounded-array/record tests, and extended the real stdio smoke test for map and offset validation. The Thalovant SDK and transport/auth configuration were unchanged.

Transparency: Codex (exact runtime model identifier unavailable) reviewed primary advisories and upstream `main`, made the scoped updates and ran local verification. The user authorized dependency remediation; parent-agent review and hosted checks preceded merge. No legal approval, mobile release approval, npm publication or deployment is implied.
