Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Index the chat apps tools added in 0.7.0.

# MCP Documentation

- [README](../README.md): installation, configuration, tools and runtime compatibility.
- [Chat Apps](../README.md#chat-apps): the chat app tools, what each bridge's status means, and why tokens stay in the console.
- [Security policy](../SECURITY.md): reporting vulnerabilities.
- [Changelog](../CHANGELOG.md): release changes.
- [Quick facts](../QUICK_FACTS.md) and [FAQ](../FAQ.md): package facts, tool counts, chat apps and the dependency patch.
- [Audit](../AUDIT.md), [maintenance report](../MAINTENANCE_REPORT.md) and [follow-up](../SUGGESTIONS.md): evidence, boundaries and remaining publication gates.

## Chat apps tools (0.7.0)

Each tool calls one `ThalovantControlPlane` method of `@thalovant/sdk` 0.10.0 and
shapes the answer in `src/chat-apps-output.ts`.

| Tool | SDK method | Route | Kind |
| --- | --- | --- | --- |
| `thalovant_list_chat_app_connectors` | `listChatAppConnectors()` | `GET /v1/bridges/connectors` | read-only |
| `thalovant_get_bridge_networks` | `getBridgeNetworks({ hubId })` | `GET /v1/bridges/networks` | read-only |
| `thalovant_list_bridges` | `listBridges({ hubId, ownerId, limit })` | `GET /v1/bridges` | read-only |
| `thalovant_get_bridge` | `getBridge(id)` | `GET /v1/bridges/{id}` | read-only |
| `thalovant_list_bridge_chats` | `listBridgeChats(id)` | `GET /v1/bridges/{id}/chats` | read-only |
| `thalovant_pause_bridge` | `updateBridge(id, { paused: true }, { etag })` | `PATCH /v1/bridges/{id}` | write |
| `thalovant_resume_bridge` | `updateBridge(id, { paused: false }, { etag })` | `PATCH /v1/bridges/{id}` | write |
| `thalovant_update_bridge` | `updateBridge(id, { allowed, requireMention, sessionScope, settings }, { etag })` | `PATCH /v1/bridges/{id}` | write |
| `thalovant_send_bridge_test_message` | `sendBridgeTestMessage(id, chatId)` | `POST /v1/bridges/{id}/test` | write |
| `thalovant_delete_bridge` | `deleteBridge(id)` | `DELETE /v1/bridges/{id}` | destructive, opt-in |

Not exposed, on purpose: `createBridge()`, `replaceBridgeToken()` and
`replaceBridgeSecrets()` take a credential, and no tool of this server takes
one; the person uses the console. `getBridgeAvatar()` answers image bytes a
model has no use for.

In `src/chat-apps-output.ts`:

- `bridgeView()` builds a bridge from the members the API documents, without
  `status.message` and `status.operator_reason`.
- `bridgeStatusSummary()` words `status.reason`, `hold` and `status.applied`.
- `connectorsOutput()`, `networksOutput()` and `chatsOutput()` shape the other
  answers.
- `bridgeErrorHint()` adds a hint by refusal code, naming
  `ThalovantApiError.fields`.
- `secretLookingSettings()` finds settings whose names look like a credential.
  `src/index.ts` registers the tools and refuses those settings before any
  request.
