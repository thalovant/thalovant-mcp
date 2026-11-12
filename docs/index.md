Last Edit: Claude Sonnet 5.5 - 2026-11-11 - Motive: CodeRabbit on 5179dbf (PR 128): uncertain delivery keeps the key, id/status required, interval needs a count, four-tool denylist, text-storage scope.

# MCP Documentation

- [README](../README.md): installation, configuration, tools and runtime compatibility.
- [Browser Sign-In](../README.md#browser-sign-in): signing a person in through the browser on their own computer over stdio, and why a hosted server uses a device login.
- [Chat Apps](../README.md#chat-apps): the chat app tools, what each bridge's status means, and why tokens stay in the console.
- [Intercom](../README.md#intercom): the speaker and announcement tools, the opt-in, the not-a-safety-system notice, and why the four runtime tools that reach a hub (`thalovant_emit_event`, `thalovant_send_action`, `thalovant_ask`, `thalovant_query`) should be denied beside it.
- [Security policy](../SECURITY.md): reporting vulnerabilities.
- [Changelog](../CHANGELOG.md): release changes.
- [Quick facts](../QUICK_FACTS.md) and [FAQ](../FAQ.md): package facts, tool counts, chat apps and the dependency patch.
- [Audit](../AUDIT.md), [maintenance report](../MAINTENANCE_REPORT.md) and [follow-up](../SUGGESTIONS.md): evidence, boundaries and remaining publication gates.

## Browser sign-in tools (0.8.0)

`src/index.ts` registers both tools; `src/browser-login.ts` holds what runs
between them. Over stdio they call `ThalovantControlPlane.interactiveLogin()` of
`@thalovant/sdk` 0.11.0 ([thalovant-node-sdk: README "Sign in"]); over
Streamable HTTP, `beginDeviceLogin()`, exactly as `thalovant_begin_device_login`.

| Tool | stdio | Streamable HTTP |
| --- | --- | --- |
| `thalovant_begin_browser_login` | `interactiveLogin({ method, scopes, deviceName, timeoutMs, signal, openUrl })`, answered once the consent URL or a device code is known | `method: "browser"` refused; `auto` and `device`: `beginDeviceLogin({ scopes, clientName })` |
| `thalovant_poll_browser_login` | reads the sign-in's outcome (no API request) | none to read: HTTP sign-ins are polled with `thalovant_poll_device_login` |

In `src/browser-login.ts`:

- `SignInWatch` learns what the person is shown: the consent URL through the
  SDK's `openUrl` (then opened with `openInBrowser()`), or a device login's code
  through the control plane's `fetch` (`DeviceAuthorization.fromGrant()`); that
  page is not opened.
- `BrowserLogins` keeps each sign-in behind an opaque `loginId` bound to the
  principal (four per principal, 256 per server), hands an approved token to
  the device-login store (`DeviceLogins.approve()` in `src/device-login.ts`)
  at once, and forgets an outcome nobody polled once the wait plus five minutes
  are over.
- `browserCommand()` and `openInBrowser()` open a URL with `open`, `xdg-open`
  or `rundll32 url.dll,FileProtocolHandler`, as one argument, with no stdio.
- `defaultDeviceName()` is `thalovant-mcp on <hostname>`, cut to 120 code points.

`keepStdoutForProtocol()` in `src/index.ts` sends every console method to stderr
on the stdio entry point, since the SDK prints its prompt with `console.log`.
The shared vectors (`test/browser-login-vectors.json`) run in
`test/browser-login-vectors.test.ts`; see the Python reference's porting brief
[thalovant-python-sdk: docs/browser-login-porting.md].

## Chat apps tools (0.7.0)

Each tool calls one `ThalovantControlPlane` method of `@thalovant/sdk` 0.10.0 and
shapes the answer in `src/chat-apps-output.ts`.

| Tool | SDK method | Route | Kind |
| --- | --- | --- | --- |
| `thalovant_list_chat_app_connectors` | `listChatAppConnectors()` | `GET /v1/bridges/connectors` | read-only |
| `thalovant_get_bridge_networks` | `getBridgeNetworks({ hubId })` | `GET /v1/bridges/networks` | read-only |
| `thalovant_list_bridges` | `listBridges({ hubId, ownerId, limit })` | `GET /v1/bridges` | read-only |
| `thalovant_get_bridge` | `getBridge(id)` | `GET /v1/bridges/{id}` | read-only |
| `thalovant_list_bridge_chats` | `listBridgeChats(id)` | `GET /v1/bridges/{id}/chats` | read-only, needs `hubs:write` and a paid plan; not in read-only mode |
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
