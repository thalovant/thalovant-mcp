Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Log the 0.7.0 chat apps tools, their verification and AI transparency; and record the CodeRabbit review-body items on merged PRs #29 and #30, checked against main.

# Maintenance Report

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
