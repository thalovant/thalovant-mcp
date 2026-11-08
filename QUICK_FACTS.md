Last Edit: Claude Opus 5.5 - 2026-11-08 - Motive: Version 0.8.0 (unreleased): browser sign-in over stdio, @thalovant/sdk ^0.11.0, 61 tools.

# Quick Facts

| Fact | Value |
| --- | --- |
| Package | `@thalovant/mcp-server` (npm), `ghcr.io/thalovant/thalovant-mcp` (OCI), `io.github.thalovant/thalovant-mcp` (MCP Registry) |
| Version | 0.8.0 (unreleased; needs `@thalovant/sdk` 0.11.0 on npm first; publishing is a separate, tag-driven step, see [RELEASING.md](RELEASING.md)) |
| Entry point | `thalovant-mcp` bin, `dist/index.js`: stdio by default, Streamable HTTP with `--http` |
| Thalovant SDK | `@thalovant/sdk` ^0.11.0 (`browserLogin()`, `interactiveLogin()`, chat app methods, `ThalovantApiError.fields`) |
| Tools | 61 by default, 28 with `THALOVANT_MCP_READONLY`, 65 with `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS` |
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
| Defaults | `deviceName` `thalovant-mcp on <hostname>`; `timeoutMs` 300000 (browser), 900000 (device) |
| Prompt | SDK's `console.log` goes to stderr on stdio (`keepStdoutForProtocol()`); URL or code in the tool answer |
| Opener | `open` / `xdg-open` / `rundll32 url.dll,FileProtocolHandler` (`browserCommand()` in `src/browser-login.ts`) |
| Token | Kept server-side per principal in `DeviceLogins`; revoked with `thalovant_revoke_device_login` |
| `thalovant_config_status` | `transport`, `browserLoginAvailable`, `deviceLoginSignedIn` (either sign-in) |
| Parity | capability `browser-login`, required; vectors `test/browser-login-vectors.json` (98 cases) |
| Reference digests | current `57c7e71f6456`, candidate `49744ee385bf` |

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
