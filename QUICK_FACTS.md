Last Edit: Claude Sonnet 5.5 - 2026-11-12 - Motive: Intercom final API (platform security review): intercom:urgent check, new problem codes in tool errors, kind/can_play/policy_synced, replayed, the API's text rule; parity capability intercom recorded.

# Quick Facts

| Fact | Value |
| --- | --- |
| Package | `@thalovant/mcp-server` (npm), `ghcr.io/thalovant/thalovant-mcp` (OCI), `io.github.thalovant/thalovant-mcp` (MCP Registry) |
| Version | 0.9.0 (prepared; publishing is a separate, tag-driven step, see [RELEASING.md](RELEASING.md)) |
| Entry point | `thalovant-mcp` bin, `dist/index.js`: stdio by default, Streamable HTTP with `--http` |
| Thalovant SDK | `@thalovant/sdk` ^0.11.0 (`browserLogin()`, `interactiveLogin()`, chat app methods, `ThalovantApiError.fields`) |
| Tools | 64 by default, 30 with `THALOVANT_MCP_READONLY`, 68 with `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS`; `THALOVANT_ENABLE_INTERCOM_ANNOUNCE` adds 1 |
| Validation | `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `npm run test:smoke`, `npm run test:http` |
| Refusal hints by code (409) | `skill_unavailable_licensing`, `skill_unavailable_unpublished` (0.7.2), any other `skill_unavailable_*`, `memory_limit`, `skill_version_already_installed` (generic), in `controlPlaneErrorHint` (`src/index.ts`) |

## Browser sign-in (0.8.0)

| Fact | Value |
| --- | --- |
| Tools | `thalovant_begin_browser_login`, `thalovant_poll_browser_login` (not in read-only mode) |
| Grant | Authorization code with PKCE (S256) on `http://127.0.0.1:<port>/callback` (RFC 8252), through `interactiveLogin()` of `@thalovant/sdk` |
| Methods | `auto` (default), `browser`, `device` |
| stdio | `auto`: the browser when `canOpenBrowser()` and `GET /v1/auth/native/config` is usable, else a device login |
| Streamable HTTP | `browser` refused; `auto`/`device` = `beginDeviceLogin()`, polled with `thalovant_poll_device_login` |
| Defaults | `deviceName` `thalovant-mcp on <hostname>` (an empty string sends none); `timeoutMs` 300000 (browser), 900000 (device) |
| Prompt | SDK's `console.log` goes to stderr on stdio (`keepStdoutForProtocol()`); URL or code in the tool answer |
| Opener | `open` / `xdg-open` / `rundll32 url.dll,FileProtocolHandler` (`browserCommand()` in `src/browser-login.ts`) |
| Token | Kept server-side per principal in `DeviceLogins`; revoked with `thalovant_revoke_device_login` |
| `thalovant_config_status` | `transport`, `browserLoginAvailable`, `deviceLoginSignedIn` (either sign-in) |
| Parity | capability `browser-login`, required; vectors `test/browser-login-vectors.json` (119 cases, from Python 39e31d8) |
| Reference digests | current `57c7e71f6456`, final candidate `6dfb3bb31ac7` |

## Intercom tools (0.9.0)

| Tool | Route | Scope | Kind |
| --- | --- | --- | --- |
| `thalovant_intercom_list_speakers` | `GET /v1/hubs/{hub_id}/intercom/speakers` | `intercom:read` | read-only |
| `thalovant_intercom_get_announcement` | `GET /v1/hubs/{hub_id}/intercom/announcements/{id}` | `intercom:read` | read-only |
| `thalovant_intercom_cancel_announcement` | `POST /v1/hubs/{hub_id}/intercom/announcements/{id}/cancel` | `intercom:send` | write, idempotent (`destructiveHint: false`); registered unless read-only mode, with or without the announce opt-in |
| `thalovant_intercom_announce` | `POST /v1/hubs/{hub_id}/intercom/announce` | `intercom:send` | write, `destructiveHint: true`; registered only with `THALOVANT_ENABLE_INTERCOM_ANNOUNCE=1` |

| Setting | Value |
| --- | --- |
| `THALOVANT_ENABLE_INTERCOM_ANNOUNCE` | registers the announce tool (default off) |
| `THALOVANT_INTERCOM_ALLOWED_HUBS` | comma-separated hub UUIDs for all four tools; unset = any hub the token reaches; no valid UUID = nothing allowed |
| `THALOVANT_INTERCOM_RATE_NORMAL_PER_MINUTE` / `THALOVANT_INTERCOM_RATE_URGENT_PER_HOUR` | per-principal caps on announce, defaults 20 and 5 (values below 1 keep the default) |
| `THALOVANT_INTERCOM_AUDIT_HMAC_KEY` | key of the audit digest `textSha256` (HMAC-SHA256); unset = random per process |

- Not a certified safety system. Off by default at every level (hub feature, each speaker's `receive`, this tool).
- Text: the API's rule (NFC, trimmed, 1-280 characters, no `<` `>`, control, text-direction or other format characters, lone surrogates, private use or separators; the two joiners allowed); `lang` a language tag; urgent needs the scope `intercom:urgent` as well as `intercom:send` (refused before the prompt when a sign-in's granted scopes are known and lack it, else by the API's `403 urgent_scope_required`); explicit targets (`speakers` | `rooms` | `groups`, or `allowAll: true`); `repeatIntervalSeconds` needs `repeatTimes`.
- **Confirmation:** urgent and `allowAll` need the person's confirmation through MCP elicitation (`src/intercom-policy.ts` `requireConfirmation`), showing hub, targets, priority and text; refused when the client has no elicitation, the person declines, the client errors, or HTTP runs in JSON-response mode. `confirmUrgent: true` and `allowAll: true` remain as extra checks (the model's own assertions).
- **Hard block:** `thalovant_emit_event`, `thalovant_send_action`, `thalovant_ask`, `thalovant_query` (and `thalovant_send_code`) refuse message types starting `thalovant.intercom.` and `speak` / `ovos.utterance.speak` (`src/bus-guard.ts`), whatever `MCP_TOOL_DENYLIST` says. `thalovant_config_status`: `intercomAnnounceEnabled`, `intercomGuardrails` (no more `intercomGateNote`).
- **Idempotency:** a fresh UUID per call (a caller-supplied key must be a UUID); a replay never speaks again (24 h); never retried; after a 502 `hub_unreachable` the error carries `announcement_id`: read it before any resend.
- Speakers: `kind`, `can_play` (false = listed, never spoken to), `policy_synced` and `unavailable_reason` (`platform`...) on the list; deliveries carry `detail`; `delivered` is not heard (`delivery_note`); `replayed: true` = the stored answer for the key. Errors with hints: `urgent_scope_required`, `intercom_urgent_busy`, `skill_not_installed`, `not_a_speaker`, `too_many_targets`, `hub_locked`, `impersonation_not_allowed`, `intercom_unavailable`, `intercom_disabled_platform`, `intercom_not_configured`, `managed_client`, `reserved_name`, `not_cancellable` (current status), `hub_unreachable`.
- Output: labels (names, rooms, groups, `acked_by`) cleaned and cut at 80 characters, with a note that they are data (`cleanLabel` in `src/intercom-output.ts`); whitelist; no text.
- Audit (`MCP_AUDIT_LOG`, off by default): `mcp.intercom.announce` (`textLen`, `textSha256` HMAC, `targets`, `priority`, outcome or `refused` + `reason`) and `mcp.intercom.cancel`; never the text. The MCP client that sent it may keep it in its own history, which this server cannot control.
- Dependency: `src/intercom-sdk.ts` calls the routes directly until `@thalovant/sdk` publishes its intercom methods.
- Parity: capability `intercom`, required, against the Python reference digest `69badc4fb072` (`contracts/sdk-parity.json`).

## Chat apps tools (0.7.0)

| Tool | Route | Kind |
| --- | --- | --- |
| `thalovant_list_chat_app_connectors` | `GET /v1/bridges/connectors` | read-only |
| `thalovant_get_bridge_networks` | `GET /v1/bridges/networks` | read-only |
| `thalovant_list_bridges` | `GET /v1/bridges` | read-only |
| `thalovant_get_bridge` | `GET /v1/bridges/{id}` | read-only |
| `thalovant_list_bridge_chats` | `GET /v1/bridges/{id}/chats` | read-only, but `hubs:write` and a paid plan; not in read-only mode |
| `thalovant_pause_bridge` | `PATCH /v1/bridges/{id}` `paused: true` | write |
| `thalovant_resume_bridge` | `PATCH /v1/bridges/{id}` `paused: false` | write |
| `thalovant_update_bridge` | `PATCH /v1/bridges/{id}` | write |
| `thalovant_send_bridge_test_message` | `POST /v1/bridges/{id}/test` | write |
| `thalovant_delete_bridge` | `DELETE /v1/bridges/{id}` | destructive, opt-in |

- No tool creates a bridge or replaces its token or secrets: those take a credential, which no tool accepts. The console does it.
- Status words: `status.summary`, built by `bridgeStatusSummary()` in `src/chat-apps-output.ts` from `status.reason`, `hold` and `status.applied`.
- Never output: `status.message`, `status.operator_reason`, token or secret values.
- Scopes: reads `hubs:read`, except `thalovant_list_bridge_chats` (`hubs:write` and a paid plan: it asks the network); writes `hubs:write` and a paid plan, except pausing and deleting.
- Parity: capability `chat-apps`, required, in `contracts/sdk-parity.json`.

## 0.6.6 dependency patch (published 2026-10-26)

- Runtime dependency fixes: body-parser 2.4.0, Zod 4.6.7, fast-uri 3.1.9. Schema differences and evidence: [AUDIT.md](AUDIT.md).
