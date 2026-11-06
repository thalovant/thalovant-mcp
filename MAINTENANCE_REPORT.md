Last Edit: Claude Fable 5.1 - 2026-11-06 - Motive: Log the 0.7.1 refusal hints (skill_unavailable_licensing, memory_limit) and their verification.

# Maintenance Report

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

### Transparency Report

- **AI Model**: Claude Fable 5.1.
- **Actions Taken**: Audited every SDK and the MCP against thalovant-api's impact declarations; found these two deferred items; wrote the hints, the profile, the tests and these notes; refreshed the parity evidence hashes; opened the pull request.
- **Oversight**: Run by an agent on the repository owner's request to bring the SDKs and MCP up to date with the platform's features; the pull request goes through the normal CI gates, and its merge and the 0.7.1 tag wait for the owner.

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
