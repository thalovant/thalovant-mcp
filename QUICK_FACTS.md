Last Edit: Claude Fable 5.1 - 2026-11-06 - Motive: Version 0.7.1 prepared: hints for skill_unavailable_licensing and memory_limit.

# Quick Facts

| Fact | Value |
| --- | --- |
| Package | `@thalovant/mcp-server` (npm), `ghcr.io/thalovant/thalovant-mcp` (OCI), `io.github.thalovant/thalovant-mcp` (MCP Registry) |
| Version | 0.7.1 (prepared; publishing is a separate, tag-driven step, see [RELEASING.md](RELEASING.md)) |
| Entry point | `thalovant-mcp` bin, `dist/index.js`: stdio by default, Streamable HTTP with `--http` |
| Thalovant SDK | `@thalovant/sdk` ^0.10.0 (chat app methods, `ThalovantApiError.fields`) |
| Tools | 59 by default, 28 with `THALOVANT_MCP_READONLY`, 63 with `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS` |
| Validation | `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `npm run test:smoke`, `npm run test:http` |

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
