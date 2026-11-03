Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Audit the 0.7.0 chat apps tools from test results and code review; keep the 0.6.6 dependency audit.

# Audit

## 0.7.0 chat apps tools (2026-11-03)

### Test evidence

Run against `@thalovant/sdk` 0.10.0, packed from its chat apps branch and installed without saving; the published 0.10.0 is not on npm yet.

| Step | Result |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run build` | passed |
| `npm test`, 2 workers | 380 tests passed in 20 files; `main` had 310 in 18 |
| `npm run test:smoke` | 2 passed |
| `npm run test:http` | 9 passed |
| Conformance (`THALOVANT_CONFORMANCE_OUT`) | structurally identical to `contracts/conformance-results.json` |

The new tests are in three files:

- [test/chat-apps-output.test.ts](test/chat-apps-output.test.ts) has 42 unit tests.
- [test/chat-apps.test.ts](test/chat-apps.test.ts) has 27 stdio tests against the built server and a loopback API.
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
8. **Release blocker.** `package.json` still asks for `@thalovant/sdk` ^0.9.9, whose published versions have no chat app methods. Hosted CI typechecks against those and fails until 0.10.0 is published and the dependency and lock move to ^0.10.0.

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
