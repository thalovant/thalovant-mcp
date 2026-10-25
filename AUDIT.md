Last Edit: Codex (exact runtime model identifier unavailable) - 2026-10-25 - Motive: Record primary advisories and tested MCP compatibility boundaries.

# Dependency Security Audit

## Primary Sources

- [body-parser GHSA-27r3-jxmh-p828](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828): CVE-2026-111181 is fixed in 2.4.0, now locked. Express's declared range accepts it.
- [Zod 4.6.6 release](https://github.com/colinhacks/zod/releases/tag/v4.6.6): fixes bounded array/set/map size validation before element parsing. This patch locks 4.6.7; the MCP SDK declares Zod 4 support. No incompatible transitive override.
- [fast-uri 3.1.9 release](https://github.com/fastify/fast-uri/releases/tag/v3.1.9): fixes scheme/host/path normalization issues. The existing override moves from 3.1.8 to 3.1.9.

No scanner suppression or policy exception is added. Version-floor tests are regression guards, not a substitute for future advisory scans. Zod's fixed early bound check only helps schemas with a declared bound; this change does not claim all unbounded input is safe.

## Compatibility

Compared the public `tools/list` catalogs from the previous 0.6.5 build and the patched build using credential-free local stdio clients. Both list 50 default tools. The five record schemas retain string keys and their prior value types. Zod 4's serializer adds `propertyNames`, inlines repeated records and emits `{}` instead of `true` for passthrough objects. It omits `additionalProperties: false` for stripping objects; runtime parsing still strips unknown keys. UUID schemas now add an RFC version/variant pattern (plus nil/max UUIDs), and memory-list `offset` gains the safe-integer maximum 9007199254740991. Validation errors can use Zod 4 wording.

Regression coverage exercises the actual stdio catalog, invalid slot values and unsafe offsets, plus direct bounded-array early rejection and stripping-map semantics. Existing HTTP authentication, transport, cancellation, runtime and SDK conformance tests remain enabled. No public API endpoints, permissions or legal/mobile release settings change.

## Verification Boundary

Local install/audit reports zero vulnerabilities. Typecheck, build and all 310 tests across 18 files pass with one worker, including the real stdio and HTTP transport suites. Separate stdio smoke (2 tests) and HTTP checks (8 tests) also pass. Hosted checks and release artifact scans remain required. Earlier unrestricted parallel runs hit subprocess deadlines on the shared workstation; no timeout or assertion was weakened.

0.6.6 is prepared, not published. Before production adoption, the existing release workflow must publish matching npm/OCI/registry metadata and pass the published-artifact smoke checks. This source audit is not proof of live rollout or legal clearance.
