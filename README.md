Last Edit: Claude Sonnet 5.5 - 2026-11-11 - Motive: CodeRabbit on 5179dbf (PR 128): uncertain delivery keeps the key, id/status required, interval needs a count, four-tool denylist, text-storage scope.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thalovant/.github/main/profile/assets/thalovant-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thalovant/.github/main/profile/assets/thalovant-logo-light.png">
    <img src="https://raw.githubusercontent.com/thalovant/.github/main/profile/assets/thalovant-logo-light.png" alt="Thalovant" width="320">
  </picture>
</p>

# Thalovant MCP Server

[![M8ven Live Monitored](https://m8ven.ai/badge/mcp/thalovant-thalovant-mcp-1cyhb4)](https://m8ven.ai/mcp/thalovant-thalovant-mcp-1cyhb4)

Public-ready MCP server for Thalovant control-plane and hub runtime APIs.

It uses the official Thalovant Node.js SDK and the production MCP TypeScript SDK over stdio and Streamable HTTP, so it works with local MCP hosts such as Claude Desktop, Codex, Cursor, and remote MCP clients.

## What It Includes

- stdio transport for local agents.
- Streamable HTTP transport at `/mcp` for remote agents.
- OAuth-style protected resource metadata at `/.well-known/oauth-protected-resource`.
- Static bearer tokens for simple/private deployments.
- JWT/JWKS and OAuth token introspection for production remote deployments.
- Per-principal Thalovant credentials and tool policy.
- Chat app tools: connectors, bridges and their status in words, pause and resume, chats, test messages and the plan's allowance. Bot tokens stay in the console.
- Intercom tools: list the speakers of a hub, read an announcement, and (opt-in) say a short text aloud in a home. Not a safety system; neither the platform nor this server stores the text (an MCP client may keep it in its own history).
- Host/origin validation, CORS, rate limiting, body limits, secure headers, and session binding.
- Optional resumability event storage and JSONL audit logs.
- Docker, Compose, Kubernetes, CI, npm package metadata, and MCP registry `server.json`.

## Why TypeScript

Thalovant publishes SDKs for Python, Node.js, Go, and Rust. This server uses Node.js because `@thalovant/sdk` directly exposes the Thalovant control plane, identity loading, WSS/HTTPS/MQTT runtime clients, memory, analytics, and context helpers, while `@modelcontextprotocol/sdk` is the best-supported path for cross-agent stdio and Streamable HTTP servers.

## Install

Run the published package with `npx -y @thalovant/mcp-server`, or build it from a checkout:

```bash
npm install
npm run build
```

Node.js 20 or newer is required.

## Control-Plane Auth

Public hub discovery does not need Thalovant credentials. Private control-plane tools and runtime hub tools read credentials only from the MCP server environment or server-side principal credential files. Do not pass API tokens or passwords through chat or tool arguments.

The server selects control-plane auth in this order:

1. `THALOVANT_API_TOKEN` — a scoped Thalovant API token. Recommended.
2. `THALOVANT_ACCESS_TOKEN` — a pre-issued session access token.
3. `THALOVANT_EMAIL` + `THALOVANT_PASSWORD` — interactive-account login fallback.

When a token is set, the server never calls the login endpoint. `thalovant_config_status` reports the active mode as `controlPlaneAuthMode` without revealing token values.

With none of these configured, a person can sign the server in instead: through the browser on their own computer when the server runs over stdio ([Browser Sign-In](#browser-sign-in)), or with a device code anywhere ([Device Sign-In](#device-sign-in)). The token a sign-in mints is used only when nothing above is configured.

### Browser Sign-In

Over stdio the server usually runs on the person's own computer, so it can sign them in through their browser, as `aws sso login` does: the authorization code grant with PKCE on a loopback redirect (RFC 8252), through `interactiveLogin()` of `@thalovant/sdk` 0.11.0. Only a browser that shares the server's `127.0.0.1` can complete it, so a link or code sent to someone on another computer delivers nothing to the sender. That promise is the browser path's alone: a device login's code signs this server in as whoever approves it, from any device, so it is shown only to the person signing in. A tool call cannot wait for a person, so it is two tools:

1. `thalovant_begin_browser_login` with optional `method` (`auto`, the default; `browser`; `device`), `scopes`, `deviceName` (what the consent page and the token list show, default `thalovant-mcp on <hostname>`; an empty string sends no name) and `timeoutMs` (default 300000 for the browser, 900000 for a device login; on either transport the server stops polling for a device code past it, and `expiresIn` says the shorter of the two; the code itself stays approvable at the API until its own expiry, but approving it then signs nothing in here, so the poll's `expired` answer tells the person not to).
   - `auto` signs in through the browser when this computer can show one and the API offers it: never with `CI`, `SSH_CONNECTION` or `SSH_TTY` set; on macOS and Windows yes; elsewhere only with `DISPLAY` or `WAYLAND_DISPLAY`. The server listens on `127.0.0.1` on a port the system picks, opens the browser at Thalovant's consent page (`open`, `xdg-open` or `rundll32 url.dll,FileProtocolHandler`), and answers `loginId`, `method: "browser"`, `authorizationUrl` (to give the person if no browser opened; it must be opened on this same computer), `interval` and `expiresIn`.
   - Otherwise, and when the API does not offer browser sign-in yet (its `GET /v1/auth/native/config` answers 404), `auto` starts a device login: the answer has `method: "device"` with `userCode`, `verificationUri`, `verificationUriComplete`, `interval` and `expiresIn`, as `thalovant_begin_device_login`'s does. The server does not open that page; the person reads the code from the model.
   - `browser` forces the browser and fails rather than become a device login; `device` forces a device login.
   - The browser has to share the server's loopback interface. A stdio server started over SSH, or inside a container, has a `127.0.0.1` of its own: `auto` already picks a device login over SSH (`SSH_CONNECTION`, `SSH_TTY`) and without a display, but a forced `browser` there waits for an answer that never arrives unless the port is forwarded. Use `method: "device"` when the person's browser is not on the server's machine.
2. `thalovant_poll_browser_login` with that `loginId` asks the server once, without a request to the API. `outcome` is `pending` (poll again after `interval` seconds), `approved` (with `tokenType`, `tokenId`, `scopes` and `expiresAt`), `denied`, `expired` or `error` (with the API's `status`, `code` and `detail`). An ended sign-in's outcome is kept for five minutes past its wait; after that, or once a device code has expired at the API, a poll answers a tool error saying the sign-in expired or ended. `method` says which way it went. Once the browser was opened, its outcome stands: a denial or a timeout never turns into a device login.

The SDK prints the same prompt a command line shows (`Opening your browser to sign in to Thalovant. If it does not open, visit:` and the URL, or a device login's code). Over stdio, stdout is the MCP protocol stream, so the stdio server sends every console line to stderr, its log, which MCP clients show; the tool's answer carries the URL or code for the model. The PKCE verifier, the state, the device code and the token stay on the server, bound to the principal that began the sign-in; an approved token is used at once by every control-plane tool for that principal when nothing is configured, and `thalovant_revoke_device_login` signs it out like a device sign-in's token. A sign-in reaches only the configured API origin.

Over Streamable HTTP a hosted server's `127.0.0.1` is not the person's computer, so a browser sign-in could never come back to it. There, `thalovant_begin_browser_login` with `method: "browser"` is refused before any request, and `auto` or `device` starts a device login exactly as `thalovant_begin_device_login` does (polled with `thalovant_poll_device_login`). Device sign-in below is unchanged on both transports, and it is the one for a registered app such as Home Assistant (`clientId`). `thalovant_config_status` reports `transport` and `browserLoginAvailable`, and `deviceLoginSignedIn` is true after either sign-in.

### Device Sign-In

A tool call cannot wait for a person, so the device flow (RFC 8628) is two tools:

1. `thalovant_begin_device_login` with optional `scopes` (an empty list, like none, asks for the API's default), `clientName` and `clientId` answers `loginId`, `userCode`, `verificationUri`, `verificationUriComplete`, `interval` and `expiresIn`. Show the person the URL and the code. `clientId` signs in as a registered app, `thalovant-home-assistant` for Home Assistant: the approval page shows the platform's name for it as verified, and approving it again replaces the token it already holds. An id the API does not know is refused (400 `unknown_client`).
2. `thalovant_poll_device_login` with that `loginId` asks once. `outcome` is `pending` (poll again after `interval` seconds, already five seconds longer for good if the API asked to slow down), `approved` (with `tokenId`, `scopes` and `expiresAt`), `expired` or `denied`.

The device code and the token never reach the model: the server keeps both, bound to the principal that began the sign-in, for the life of the process. Once approved, every control-plane tool for that principal uses the token when no credential is configured. `thalovant_revoke_device_login` signs out: it revokes that token (a token may always revoke itself, and one already revoked counts as revoked) and forgets it; signing out again answers `alreadyRevoked` without a request, and configured tokens are never touched. A sign-in reaches only the configured API origin (`THALOVANT_API_URL`, or the default), since the verification URL it answers with is shown to a person. A Home Assistant link asks for `hubs:read`, `clients:read` and `clients:write`, which is also all a Free plan can approve.

### API Tokens (Recommended For AI Agents And CI)

Scoped API tokens are the right credential for AI and automation use: they are minted from the Thalovant dashboard (or through a browser or device sign-in), carry only the scopes you grant, can be revoked individually, and never involve your account password or MFA. Tokens start with `tvpat_`.

```bash
export THALOVANT_API_TOKEN="tvpat_..."
export THALOVANT_API_URL="https://api.thalovant.com"

npm start
```

Minimum scopes for the full control-plane tool surface:

| Scope | Used by |
|-------|---------|
| `hubs:read` | `thalovant_list_hubs`, `thalovant_get_hub`, `thalovant_get_analytics_overview`, `thalovant_list_marketplace_skills`, `thalovant_list_runtime_groups`, `thalovant_get_runtime_group`, `thalovant_get_runtime_group_config`, the guarded merge read in `thalovant_update_runtime_group_config`, the hub lookup inside `thalovant_create_client_identity`, and the chat app reads (`thalovant_list_chat_app_connectors`, `thalovant_get_bridge_networks`, `thalovant_list_bridges`, `thalovant_get_bridge`) |
| `hubs:inspect` | `thalovant_get_hub_runtime_capabilities`, `thalovant_list_runtime_group_marketplace`, `thalovant_list_runtime_group_inventory`, `thalovant_list_hub_skills`, `thalovant_list_hub_skill_history` |
| `hubs:write` | All hub and runtime-group provisioning: `thalovant_create_hub`, `thalovant_update_hub`, `thalovant_release_hub`, `thalovant_create_runtime_group`, `thalovant_update_runtime_group`, `thalovant_update_runtime_group_config`, `thalovant_release_runtime_group`, `thalovant_install_runtime_group_skill`, `thalovant_uninstall_runtime_group_skill`, the per-hub `thalovant_install_hub_skill`, `thalovant_update_hub_skill`, `thalovant_remove_hub_skill`, the hub rating tools, the chat app writes (`thalovant_pause_bridge`, `thalovant_resume_bridge`, `thalovant_update_bridge`, `thalovant_send_bridge_test_message`), `thalovant_list_bridge_chats` (it changes nothing but asks the chat network, so the API serves it only to `hubs:write` and a paid plan), and the opt-in delete tools |
| `intercom:read` | `thalovant_intercom_list_speakers`, `thalovant_intercom_get_announcement` (a plan with Intercom) |
| `intercom:send` | `thalovant_intercom_announce` (opt-in tool; a plan with Intercom, Intercom switched on for the hub). Managing speakers and the hub's switch needs `hubs:write`, which no tool of this server uses for Intercom |
| `clients:write` | `thalovant_create_client_identity` (`POST /v1/clients`) and the opt-in `thalovant_delete_client` |
| `memory:read` | `thalovant_list_memory_items`, `thalovant_get_memory_summary`, `thalovant_get_memory_item` |
| `memory:write` | `thalovant_create_memory_item`, `thalovant_update_memory_item`, `thalovant_delete_memory_item` |

The hub scopes imply one another: `hubs:write` grants `hubs:read`, which grants `hubs:inspect` and `hubs:preview`. Minting a token with `hubs:read` is therefore enough for every discovery tool in the table above.

Scope is not the whole story for provisioning. Every hub and runtime-group write also requires a **paid plan**, and the API checks scope *before* the plan, so the two failure modes are ordered:

- A token missing the scope fails `403 Insufficient scopes`. Free-plan API tokens are capped at `hubs:read`, `clients:read`, and `clients:write`, so on the free tier provisioning fails with this 403 and never reaches the 402.
- A correctly scoped token on a free plan fails `402 API access requires a paid plan.`
- `thalovant_install_runtime_group_skill` can fail with a **second, distinct** 402, `This skill requires paid marketplace access for the tenant plan.`, when the plan is paid but does not include `access_tier: paid` catalog entries.

Discovery is deliberately not paid-gated: **a free-tier token can browse the marketplace catalog and set hub ratings, but cannot install skills or provision hubs.** Use `thalovant_list_runtime_group_marketplace` before installing — it reports `installable`, `purchase_required`, and `access_message` per skill, which turns an opaque 402 into a decision you can make up front. A skill the store does not install carries `unavailable_reason` (`licensing` or `unpublished`) with `installable` and `purchase_required` false, and is listed there only for a group that already has it.

Grant fewer scopes for narrower deployments: a read-only assistant needs only `hubs:read` and `memory:read`, and a discovery-only agent that browses skills but never provisions needs `hubs:read` alone. `thalovant_get_analytics_overview` with `admin: true` additionally requires an admin account with `admin:analytics`, which API tokens for regular use should not carry. Runtime hub tools (`thalovant_ask`, `thalovant_send_action`, and friends) use Thalovant client identities, not control-plane tokens.

### Hub Etags

`thalovant_update_hub` and `thalovant_delete_hub` use optimistic locking and require the hub's current etag, sent as `If-Match`. The etag is only available in the **body** of the hub resource — the API sends no `ETag` response header — so an agent must call `thalovant_get_hub` first and pass the `etag` field from that response. A missing or stale value fails `412 ETag mismatch` and changes nothing; re-fetch and retry. `name`, `namespace`, and `domain` are immutable after creation, so `thalovant_update_hub` does not accept them at all; send only the fields you are changing rather than round-tripping a whole hub resource. Runtime-group writes do not use etags.

### Hub Skills

`thalovant_list_hub_skills`, `thalovant_install_hub_skill`, `thalovant_update_hub_skill`, and `thalovant_remove_hub_skill` select a hub's attached runtime group; all hubs sharing it are affected. A hub can start with no skills at all and gain them one at a time; a change applies live on the hub in about 15 seconds with no restart. `hubId` must be the hub UUID — the authenticated hub routes reject slugs.

`thalovant_list_hub_skills` returns the whole `GET /v1/hubs/{hub_id}/skills` envelope: `hub_id`, `runtime_group_id`, `observed_at`, `source`, the runtime's phase and message, and `data`, one row per skill (possibly empty) with `skill`, `title`, `marketplace_skill_id`, `package_name`, `source_type`, `install_source`, `version`, `version_pin`, `installed_version`, `observed_version`, `previous_version`, `latest_version`, `available_version`, `update_available`, `changelog`, `active`, `state`, the runtime's phase, message and last error, and `last_transition_at`. `state` is one of `pending`, `installed`, `failed`, `removing`, `drifted`, `quarantined`, or `unmanaged`; a change in progress shows as `pending`.

Each write answers `202` with `operation_id`, `hub_id`, `runtime_group_id`, `skill`, `version` (`null` for a removal), `previous_version`, and `state` (`installing`, `updating`, or `removing`); pass `wait: true` to poll that operation every 2 s until it converges (`installed`, or `removed` for a removal; a `failed` or `timed_out` operation raises an error carrying its `error_message`), with a 120 s default `timeoutMs`, or follow it yourself with `thalovant_get_operation`. Installing a skill that is already installed at another version performs an update; the same version fails `409` with code `skill_version_already_installed`. A hub with no runtime group fails `404` with code `hub_without_runtime_group` (a plain `404` means an unknown hub or a skill that is not installed), and an unresolvable `latest` or an invalid version fails `422`. Errors are RFC 7807 problem bodies; the tool error keeps the short `message`, which appends the root `code` in parentheses, for example `Thalovant API request failed with HTTP 409: Skill version already installed. (skill_version_already_installed)`, and then the code and the body's other fields (see [Tool Errors](#tool-errors)). A skill the store does not install for licensing reasons (YouTube, YouTube Music, Spotify, SoundCloud and Bandcamp: the service's terms do not allow a hosted assistant to play its content) fails `409` with code `skill_unavailable_licensing` and `reason: licensing`, which `thalovant_list_marketplace_skills` announces per skill as `unavailable_reason` and `installable`; no plan, scope or version changes that. A skill with no published release fails `409` with code `skill_unavailable_unpublished` and `reason: unpublished`, before any paid-plan `402`: it cannot be installed or bought until a release is published. A non-admin token does not see such a skill in `thalovant_list_marketplace_skills` at all.

Listing needs `hubs:inspect` (implied by `hubs:read`); the writes need `hubs:write` and a paid plan, and because scope is checked before plan a free-plan token sees `403`, never `402`. Hub-restricted tokens (a `hub_ids` allowlist) are honoured on all four routes. The server uses the published Node SDK hub-skill methods and preserves MCP cancellation checks during polling. A failed status read retains the accepted operation ID; use `thalovant_get_operation` with that ID instead of submitting the write again. No new poll starts at or after the polling deadline. That deadline does not cancel an HTTP request already in flight.

### Login Fallback

```bash
export THALOVANT_EMAIL="you@example.com"
export THALOVANT_PASSWORD="..."

export THALOVANT_PROFILE="prod"
export THALOVANT_API_URL="https://api.thalovant.com"

npm start
```

If neither a token nor email/password is configured, authenticated control-plane tools fail with a clear error naming the supported options.

Configured API tokens and login credentials are bound to the origin of their
configured `apiUrl` or `THALOVANT_API_URL` (default `https://api.thalovant.com`).
A tool argument cannot redirect those credentials to another origin. Equivalent
URL spellings and paths on the same origin are allowed; custom origins must be
configured alongside their credentials. Anonymous public discovery may still
select a custom API URL.

## Link Home Assistant

A home controller such as Home Assistant links to a hub with a connection of its own kind:

1. Sign in, when no token is configured: [Device Sign-In](#device-sign-in).
2. `thalovant_create_client_identity` with `connectionType: "home_assistant"`. The API must answer with the same kind; one that made an ordinary connection instead has it deleted again and the call fails. The result carries `clientId`, `connectionType` and `operationId`.
3. `thalovant_wait_for_admission` with that `operationId`. A hub admits a new connection in about ninety seconds and refuses it until then. `outcome` is `admitted`, `failed` or `timeout`. A failure on the platform carries the operation's `errorCode` (and `status` null); the API refusing the wait itself carries its `status`, `code` and `detail`. A `timeout` means the connection may still be admitted: call the tool again rather than creating another connection. A 429 is waited out for the time the API names (in its body, else `Retry-After`, else `RateLimit-Reset`); one asking for longer than is left is a `timeout` at once. A token the API refuses (401, 403) and an API out of reach are tool errors of their own, each with a hint, never a failed admission. It reads only, honours cancellation, and never follows a `links.self` to another origin than the API's.

Each refusal of step 2 names what to do next after the API's own text (see [Tool Errors](#tool-errors)): a kind the API does not know yet, a plan that does not allow the connection, a hub that already holds its one Home Assistant link (with the `client_id` holding it), or a token the API refused (sign in again). `thalovant_delete_client` removes a connection (`If-Match`, reading the etag first when none is given, retrying once on `412`, and counting a connection already gone as deleted); it is a destructive tool the operator enables.

Answering the hub's requests afterwards is the integration's own long-lived job, on the data plane; an MCP tool call holds a hub connection only for its own length, so that part of the link is not a tool.

## Chat Apps

A hub can answer in a chat network through a **chat app**: Telegram and Discord are offered, and Matrix, Mattermost and Twitch appear as beta when the API lists them. Each connection of a hub to a chat network is a *bridge* (`/v1/bridges`). The person makes the bot in the chat network, then connects it to a hub in the Thalovant console.

**Tokens and secrets stay in the console.** Creating a bridge and replacing its token or secrets need the bot's credential, and no tool of this server takes a credential as an argument (see [Control-Plane Auth](#control-plane-auth)), so there is no tool for them. The descriptions and outputs say where to go instead: Connections > Add connection > Chat apps, or the hub's Chat apps tab, and **Replace token** on the bot. `thalovant_update_bridge` refuses a setting whose name looks like a token or secret, at any depth, before any request, naming it by its dotted path and never its value.

| Tool | What it does | Kind |
|------|--------------|------|
| `thalovant_list_chat_app_connectors` | The chat apps (`GET /v1/bridges/connectors`) in `en` or `fr`: status (`offered`, `beta`), whether a bridge can be created now, description and setup steps, the secrets the console asks for (by key and label, never a value), the settings form, what a chat id looks like (`targets`), the mention rule, session scopes and helpers | read-only |
| `thalovant_get_bridge_networks` | Networks offered and the plan's allowance (`GET /v1/bridges/networks`): `limit`, `used`, `remaining`, `paid_plan`, `can_create`, and a `summary` in words. Free plans get 0. With `hubId`, the hub owner's allowance | read-only |
| `thalovant_list_bridges` | Bridges of one hub (`hubId`) or every bridge the token may see (`ownerId` narrows it; `limit` 1-500) | read-only |
| `thalovant_get_bridge` | One bridge, with its status in plain words | read-only |
| `thalovant_list_bridge_chats` | The chats, channels or rooms the bot can see, to choose from; `manual_entry: true` when the ids are typed instead. Changes nothing, but needs `hubs:write` and a paid plan (it asks the network) | read-only, write scope |
| `thalovant_pause_bridge` | `PATCH paused: true`: stops answering everywhere, keeps chats, settings and token. Always allowed | write |
| `thalovant_resume_bridge` | `PATCH paused: false`. Needs a paid plan with room in its allowance | write |
| `thalovant_update_bridge` | The chats it answers in (`allowed`, which replaces the whole list), `requireMention`, `sessionScope`, and non-secret `settings` | write |
| `thalovant_send_bridge_test_message` | Posts a short "Connected to <hub>." line in one allowed chat | write |
| `thalovant_delete_bridge` | Deletes the bridge and its stored token; opt-in like the other [destructive tools](#destructive-tools) | destructive |

Each bridge comes back with the API's own members (`network`, `connector`, `state`, `allowed`, `require_mention`, `session_scope`, `paused`, `hold`, `bot`, `invite_links`, `secrets_set` by name, `etag`, timestamps, and `operation` when the change queued one) and `status`:

- `reason` is the API's customer-safe status, and `summary` says it in words: `Setup` (no chats chosen yet), `Starting`, `Connected`, `Paused`, `Unavailable`, `TokenMissing` and `TokenRejected` (both send the person to **Replace token** in the console). A reason this server does not know yet is kept and named.
- `phase`, `ready`, and `applied`: `true` once the bridge carries the latest change, `false` while it is on its way, `null` in setup.
- `hold` says why the platform paused a bridge: `plan_limit` (the plan allows fewer running chat apps, after a downgrade; it resumes on its own once there is room) or `account_suspended`. It is `null` for the owner's own pause.

The platform's own diagnostic sentence and condition (`status.message`, `status.operator_reason`, sent to administrators' tokens) are never included. Outputs are built from the members the API documents rather than passed through, so a member added later does not reach the model unreviewed; `settings` and `operation` go through the usual secret redaction.

The write tools take an optional `etag` (the bridge's `etag` field; there is no ETag header), sent as `If-Match`: a stale one fails `412` and changes nothing. Telegram lists chats only while its bridge is paused (`409 bridge_running`), so the flow is pause, send `/start@<bot>` in the new group, list, update `allowed`, resume. A refusal keeps the API's code, sentence and fields (see [Tool Errors](#tool-errors)) and adds a hint by code: the settings a `bridge_settings_invalid` or `bridge_url_*` refusal names (names only), the plan's allowance after `402` or `403 plan_limit`, the wait after `429`, and the console for anything about a token.

Reads need `hubs:read`, except `thalovant_list_bridge_chats`: it changes nothing, but it asks the chat network on the bot's behalf, so it needs `hubs:write`, the hub's owner or a workspace manager, and a paid plan, like the writes. Writes need the same, except pausing and deleting, which always work on any plan. `THALOVANT_MCP_READONLY` keeps the four reads a `hubs:read` token can call and leaves `thalovant_list_bridge_chats` out.

## Intercom

Intercom lets an agent say a short sentence aloud on the speakers of a hub, in a home: "dinner is ready", "the delivery is at the door". It is announce-only: no two-way audio, no listening. Each speaker (a client of the hub) says the text with its own text-to-speech.

**Intercom is not a certified safety system.** It does not replace smoke or CO alarms, medical alert devices or emergency services, and an announcement can fail (offline speaker, do-not-disturb, no one in the room). Never use it, or tell anyone to rely on it, for an emergency.

It is off at every level, and each level is the household's to turn on:

| Level | Default | Who changes it |
| --- | --- | --- |
| The hub's Intercom feature | off; never available on kid or public hubs; plan gate (paid plans that own hubs) | the hub's owner or an admin (console, or `PUT /v1/hubs/{hub_id}/intercom/settings`; no tool of this server does it) |
| Each speaker's `receive` | `false`: a speaker with `receive` false is never spoken to, urgent or not | the same, per speaker |
| Do-not-disturb (quiet hours) | off; skips normal announcements only | the same, per speaker |
| This server's announce tool | not registered | the operator sets `THALOVANT_ENABLE_INTERCOM_ANNOUNCE=1` |

| Tool | Route | Scope | Kind |
| --- | --- | --- | --- |
| `thalovant_intercom_list_speakers` | `GET /v1/hubs/{hub_id}/intercom/speakers` | `intercom:read` | read-only |
| `thalovant_intercom_get_announcement` | `GET /v1/hubs/{hub_id}/intercom/announcements/{id}` | `intercom:read` | read-only |
| `thalovant_intercom_announce` | `POST /v1/hubs/{hub_id}/intercom/announce` | `intercom:send` | write, only with `THALOVANT_ENABLE_INTERCOM_ANNOUNCE` |

`thalovant_intercom_announce` checks everything it can before any request, and no check or error repeats the text:

- `text`: 1 to 280 characters after trimming, plain: control characters, line breaks, text-direction marks and `<` `>` (a speech engine may read them as SSML) are refused.
- Explicit targets, one kind per call: `speakers` (client ids or slugs, at most 50), `rooms`, or `groups`. Speaking on every speaker needs `allowAll: true` and no other target; naming nothing is refused, never read as everyone.
- `priority: "urgent"` repeats until someone says they heard it, ignores do-not-disturb and answers `sending` (HTTP 202); it needs `confirmUrgent: true`, which is the caller's own assertion that the person confirmed: the model is told to set it only after they did, but this server cannot verify it, so it stops a careless call and is not proof of confirmation. `repeatTimes` (1-10) and `repeatIntervalSeconds` (5-120, default 30) are urgent only, and `repeatIntervalSeconds` is refused without `repeatTimes` (it would otherwise be dropped silently).
- It sends once, with an `Idempotency-Key` (generated, or `idempotencyKey`). If the API cannot be reached, the answer's body is cut off or stalls, or a success comes back without the announcement's `id` and `status`, the announcement may already have been spoken, so it is **not** retried: the error says so, gives the key, and says to read the announcement first (`thalovant_intercom_get_announcement`) or ask the household. Resend only with the same key. A `502` (the hub did not answer) and any other server error (5xx) of the announce call name the key too.
- The platform limits a hub to 20 normal announcements a minute and 10 urgent an hour (`429`).
- The tool's description says the text is spoken aloud in a home and carries the not-a-safety-system notice, and so does every answer.

**The platform and this server never store the text.** The platform keeps only its length, SHA-256, targets and per-speaker results; this server writes a record `mcp.intercom.announce` to the audit log with `textLen`, `textSha256`, `targets`, `priority`, `hubId`, the idempotency key and the outcome, **even when `MCP_AUDIT_INCLUDE_ARGS` is off**, and when it is on the generic entry shows `text` as `[omitted: N characters]`. Outputs are whitelisted (`src/intercom-output.ts`): the answer carries each speaker's result (`delivered`, `acked`, `offline`, `skipped_dnd`, `skipped_not_receiving`, `failed`), `acked_by` and a summary in words, never any text. That holds for the platform and this server only: the MCP client that sent the announcement can keep the text in its own conversation or tool-call history, which this server cannot control.

**The opt-in is one door among several.** `thalovant_emit_event`, `thalovant_ask`, `thalovant_query` and `thalovant_send_action` reach a hub as a client identity and can send it any event, including one the hub's intercom skill answers. Leaving `THALOVANT_ENABLE_INTERCOM_ANNOUNCE` unset does not close that route. An operator for whom the Intercom opt-in must be the only way to speak in a home also denies all four of those tools, because each reaches the hub's intercom skill:

```bash
export THALOVANT_ENABLE_INTERCOM_ANNOUNCE=1
export MCP_TOOL_DENYLIST="thalovant_emit_event,thalovant_send_action,thalovant_ask,thalovant_query"
```

`thalovant_config_status` reports `intercomAnnounceEnabled` and, when the opt-in is on and one of those tools is still allowed, an `intercomGateNote` naming them. The same applies to a hub's own routines and skills: they speak through the hub's intercom skill under the hub's own per-speaker settings, which this server does not change.

`THALOVANT_MCP_READONLY` keeps the two reads and leaves the announce tool out, even with the opt-in. See [Intercom in the docs](https://docs.thalovant.com/concepts/intercom/).

> **Dependency note.** The Node SDK's intercom methods (`announce`, `getAnnouncement`, `listIntercomSpeakers`, ...) are not published yet. Until they are, `src/intercom-sdk.ts` calls the same routes directly (same origin, HTTPS and no-redirect rules as the SDK, no retry). Swap its three functions for the SDK's when `@thalovant/sdk` ships them; nothing else changes.

## Local Stdio

The server speaks MCP over stdio and does not write logs to stdout.

Runtime hub tools load local identities in this order:

1. `identityFile` tool argument.
2. `configPath` or `profile` tool argument.
3. Thalovant SDK environment identity variables.
4. The default Thalovant SDK config profile.

Keep Thalovant identity files secret. The SDK expects protected config files such as `~/.config/thalovant/config.yaml` with mode `0600`.

## Streamable HTTP

Remote mode uses MCP Streamable HTTP at `/mcp` and requires bearer authentication by default.

```bash
export MCP_TRANSPORT="http"
export MCP_HTTP_HOST="127.0.0.1"
export MCP_HTTP_PORT="3000"
export MCP_HTTP_AUTH_TOKEN="$(openssl rand -hex 32)"
export MCP_HTTP_ALLOWED_HOSTS="127.0.0.1:3000,localhost:3000"

npm run start:http
```

Clients connect to:

```text
http://127.0.0.1:3000/mcp
Authorization: Bearer <token>
```

Health checks are available at `/healthz` and `/readyz`.

For public deployments, set the public URL and exact host/origin allowlists:

```bash
export MCP_HTTP_HOST="0.0.0.0"
export MCP_HTTP_PORT="3000"
export MCP_PUBLIC_URL="https://mcp.example.com"
export MCP_HTTP_ALLOWED_HOSTS="mcp.example.com"
export MCP_HTTP_ALLOWED_ORIGINS="https://agent.example.com"
```

## Remote Auth

Use static bearer tokens only for local, private, or single-tenant deployments:

```bash
export MCP_HTTP_AUTH_TOKEN="$(openssl rand -hex 32)"
# or
export MCP_HTTP_AUTH_TOKENS="token-a,token-b"
```

Use JWT/JWKS for production resource-server validation:

```bash
export MCP_HTTP_AUTH_MODE="jwt"
export MCP_OAUTH_ISSUER="https://auth.example.com/"
export MCP_OAUTH_JWKS_URL="https://auth.example.com/.well-known/jwks.json"
export MCP_OAUTH_AUDIENCE="https://mcp.example.com/mcp"
export MCP_OAUTH_AUTHORIZATION_SERVERS="https://auth.example.com/"
export MCP_OAUTH_REQUIRED_SCOPES="mcp:thalovant"
```

Use introspection when your authorization server issues opaque tokens:

```bash
export MCP_HTTP_AUTH_MODE="introspection"
export MCP_OAUTH_INTROSPECTION_URL="https://auth.example.com/oauth2/introspect"
export MCP_OAUTH_CLIENT_ID="mcp-server-client"
export MCP_OAUTH_CLIENT_SECRET="..."
export MCP_OAUTH_AUDIENCE="https://mcp.example.com/mcp"
export MCP_OAUTH_AUTHORIZATION_SERVERS="https://auth.example.com/"
export MCP_OAUTH_REQUIRED_SCOPES="mcp:thalovant"
```

The server publishes protected resource metadata at:

```text
https://mcp.example.com/.well-known/oauth-protected-resource
```

401 responses include `WWW-Authenticate` with a `resource_metadata` pointer for MCP clients that support OAuth discovery.

## Principal Credentials

For multi-user remote deployments, do not share one Thalovant access token across all MCP users. Map each authenticated MCP principal to its own Thalovant control-plane token, runtime identity, and tool policy.

Single file:

```bash
export THALOVANT_PRINCIPAL_CREDENTIALS_FILE="/run/secrets/thalovant-principals.json"
```

Directory mode:

```bash
export THALOVANT_PRINCIPAL_CREDENTIALS_DIR="/run/secrets/thalovant-principals"
```

Directory files are named `<sha256(principal-id)>.json`. The server checks the OAuth subject, principal id, and client id. See [examples/principal-credentials.sample.json](examples/principal-credentials.sample.json).

Keep this disabled for multi-user deployments unless you intentionally want every remote principal to use the server environment's Thalovant credentials:

```bash
export THALOVANT_ALLOW_SHARED_CREDENTIALS="false"
```

Runtime `identityFile`, `configPath`, `profile`, and `fromEnv` tool arguments are disabled for remote principals by default. Set `MCP_HTTP_ALLOW_CLIENT_CREDENTIAL_PATHS=true` only for trusted private deployments.

## Policy, Audit, And Resumability

Global tool policy:

```bash
export MCP_TOOL_ALLOWLIST="thalovant_*"
export MCP_TOOL_DENYLIST="thalovant_delete_memory_item"
```

Per-principal credential files may also include `allowedTools` and `deniedTools`.

The runtime tools `thalovant_emit_event`, `thalovant_ask`, `thalovant_query` and `thalovant_send_action` can reach a hub as a client identity and send it any event. Deny all four wherever an opt-in such as `THALOVANT_ENABLE_INTERCOM_ANNOUNCE` is meant to be the only way to do what the event would do; see [Intercom](#intercom).

Both are call-time filters, and an empty allowlist means "allow everything". They cannot make a tool default-off or hide it from `tools/list`, which is why the two destructive control-plane tools are gated separately by `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS`. See [Destructive Tools](#destructive-tools).

Audit logs:

```bash
export MCP_AUDIT_LOG="stderr" # off, stderr, file, or both
export MCP_AUDIT_LOG_FILE="/var/log/thalovant-mcp/audit.jsonl"
export MCP_AUDIT_INCLUDE_ARGS="false"
```

Audit entries are JSONL and credential-shaped fields are redacted.

Streamable HTTP resumability defaults to an in-memory event store. Use a file-backed store for single-instance restarts:

```bash
export MCP_EVENT_STORE_FILE="/var/lib/thalovant-mcp/events.jsonl"
```

## HTTP Hardening

- Bearer auth is required unless `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is explicitly set.
- Host headers are allowlisted to reduce DNS rebinding risk.
- Browser `Origin` headers are rejected unless they exactly match `MCP_HTTP_ALLOWED_ORIGINS`.
- CORS exposes only MCP session/protocol headers.
- Sessions use cryptographically random ids and are bound to the authenticated principal.
- Request bodies are capped by `MCP_HTTP_MAX_BODY_BYTES`, defaulting to 1 MiB.
- Fixed-window rate limiting defaults to 120 MCP requests per minute per client address.
- Security headers include `nosniff`, `DENY` framing, no referrer, and a restrictive CSP.

Useful HTTP environment variables:

```bash
MCP_HTTP_PATH=/mcp
MCP_HTTP_RATE_LIMIT_MAX=120
MCP_HTTP_RATE_LIMIT_WINDOW_MS=60000
MCP_HTTP_SESSION_TTL_MS=3600000
MCP_HTTP_MAX_BODY_BYTES=1048576
MCP_HTTP_ENABLE_JSON_RESPONSE=false
MCP_HTTP_TRUST_PROXY=false
```

## Claude Desktop

Recommended: authenticate with a scoped API token so the MCP config never contains your account password.

```json
{
  "mcpServers": {
    "thalovant": {
      "command": "npx",
      "args": ["-y", "@thalovant/mcp-server"],
      "env": {
        "THALOVANT_API_TOKEN": "tvpat_...",
        "THALOVANT_PROFILE": "prod"
      }
    }
  }
}
```

## Codex

Use the same stdio command in your MCP client config:

```json
{
  "mcpServers": {
    "thalovant": {
      "command": "npx",
      "args": ["-y", "@thalovant/mcp-server"],
      "env": {
        "THALOVANT_API_TOKEN": "tvpat_...",
        "THALOVANT_PROFILE": "prod"
      }
    }
  }
}
```

## Tools

Read-only:

- `thalovant_config_status`
- `thalovant_list_public_hubs`
- `thalovant_get_public_hub`
- `thalovant_list_hubs`
- `thalovant_get_hub`
- `thalovant_get_operation`
- `thalovant_wait_for_admission`
- `thalovant_identity_status`
- `thalovant_healthcheck`
- `thalovant_intent_inventory`
- `thalovant_wait_for_event`
- `thalovant_get_analytics_overview`
- `thalovant_list_memory_items`
- `thalovant_get_memory_summary`
- `thalovant_get_memory_item`

Skill and runtime-group discovery (read-only):

- `thalovant_list_marketplace_skills`
- `thalovant_list_runtime_group_marketplace`
- `thalovant_list_runtime_group_inventory`
- `thalovant_list_runtime_groups`
- `thalovant_get_runtime_group`
- `thalovant_get_runtime_group_config`
- `thalovant_get_hub_runtime_capabilities`

Sign-in (see [Browser Sign-In](#browser-sign-in) and [Device Sign-In](#device-sign-in)):

- `thalovant_begin_browser_login`
- `thalovant_poll_browser_login`
- `thalovant_begin_device_login`
- `thalovant_poll_device_login`
- `thalovant_revoke_device_login`

Writes or hub events:

- `thalovant_create_client_identity`
- `thalovant_ask`
- `thalovant_query`
- `thalovant_send_action`
- `thalovant_send_code`
- `thalovant_emit_event`
- `thalovant_create_memory_item`
- `thalovant_update_memory_item`
- `thalovant_delete_memory_item`

Hub and runtime-group provisioning:

- `thalovant_create_hub`
- `thalovant_update_hub`
- `thalovant_release_hub`
- `thalovant_set_hub_rating`
- `thalovant_clear_hub_rating`
- `thalovant_create_runtime_group`
- `thalovant_update_runtime_group`
- `thalovant_update_runtime_group_config`
- `thalovant_release_runtime_group`
- `thalovant_install_runtime_group_skill`
- `thalovant_uninstall_runtime_group_skill`

Hub skills, acting on the hub’s shared runtime (see [Hub Skills](#hub-skills); the list tool is read-only):

- `thalovant_list_hub_skills`
- `thalovant_list_hub_skill_history`
- `thalovant_install_hub_skill`
- `thalovant_update_hub_skill`
- `thalovant_remove_hub_skill`

Chat apps (see [Chat Apps](#chat-apps); the first five are read-only, and `thalovant_list_bridge_chats` needs `hubs:write`):

- `thalovant_list_chat_app_connectors`
- `thalovant_get_bridge_networks`
- `thalovant_list_bridges`
- `thalovant_get_bridge`
- `thalovant_list_bridge_chats`
- `thalovant_pause_bridge`
- `thalovant_resume_bridge`
- `thalovant_update_bridge`
- `thalovant_send_bridge_test_message`

Destructive, **not registered unless explicitly enabled** (see [Destructive Tools](#destructive-tools)):

- `thalovant_delete_hub`
- `thalovant_delete_runtime_group`
- `thalovant_delete_client`
- `thalovant_delete_bridge`

Tool outputs redact credential-shaped fields. `thalovant_create_client_identity` does not return secret identity material; pass `savePath` when you want the full identity written to a local file with mode `0600`. `savePath` is confined to the server's identity directory (`THALOVANT_MCP_IDENTITY_DIR`, default `<config-dir>/thalovant/identities`): pass a plain filename, since absolute paths outside that directory and `..` traversal are rejected, so a model cannot drop a credential file into a git working tree or synced folder. `thalovant_config_status` reports the active `identityDir`.

`thalovant_intent_inventory` uses the runtime identity and accepts `languages`,
`describe`, `fallback`, `speakable`, `sentence`, `slots`, `exampleLimit`, and a per-query/batch `timeoutMs`. It returns registered
intents and examples, fallback skills, `fallbacks_known`, `listed_in`, and
`may_answer` by requested language. `listed_in` names the hub language each
requested language was listed in. A hub lists nothing under a language it did
not load, so a language with no sentences is listed in its usual form (`en-CA`
in `en-US`) or in the closest language the hub loaded, and `examples` are
rendered in that language. When `listed_in` differs from what was asked, the
sentences are in another language, and `presentation.notes` says so. Fallback
skills come from `ovos.skills.list`, in skill id order, with `priority: null`:
the hub does not say in which order it tries them. A missing or denied
fallback-skill query remains unknown, rather than being reported as a known
empty list. The optional probe adds at most 1500ms. A silent listing can use engine manifests; disable this with
`fallback: false`. Both new tools are available in read-only mode and respect
per-principal policy. `thalovant_get_operation` reads an operation ID returned by
provisioning without replaying the write.

The additive `presentation` object contains the shared SDK inventory shape:
`cache_version`, `hub_id`, `hub_name`, `source`, `generated_at`, `skills`, `notes`,
and `languages_present`. Skill titles are derived from IDs. Runtime discovery
cannot prove catalog locales or hub display metadata, so those fields remain
unknown (empty lists/strings), with explanatory notes. Intent language order is
explicit and survives JSON key sorting. Each tool call retains its own identity
lease; the server does not persist inventory or share a session across callers.

## Tool Errors

When the Thalovant API refuses a control-plane call, the tool result is an
error whose text starts with the SDK's one-line message (which names the HTTP
status and can be shortened) and then says what the API said, in full:

```text
Thalovant API request failed with HTTP 403: Only an administrator can run an image the platform does not release: bus may be one of ghcr.io/thalovant/ovos-messagebus:2026.09.2, ... (platform_image_required)
code: platform_image_required
detail: Only an administrator can run an image the platform does not release: bus may be one of ghcr.io/thalovant/ovos-messagebus:2026.09.2, ghcr.io/thalovant/ovos-messagebus:2026.09.3-alpha.1, ghcr.io/thalovant/ovos-messagebus:2026.08.7; core may be any tag or digest of ghcr.io/thalovant/ovos-core.
fields: {"allowed_images":{"bus":[...],"core":[...]},"allowed_repositories":{"core":"ghcr.io/thalovant/ovos-core"},"component":"runtime_group","refused_images":{...}}
```

- `code` is the API's machine-readable code, when it sent one.
- `detail` is the whole sentence, and appears only when the first line had to
  shorten it.
- `fields` is every other member of the error body as compact JSON (the
  Problem+JSON `type`, `title`, `status` and `instance` are left out), with the
  same secret redaction as every other tool output. A value a validation error
  echoes back from the request -- each entry's `input` in a `detail` or
  `errors` list, whatever its key or shape -- is replaced with `"[omitted]"`
  there and never reaches the first line. A plan refusal carries `resource`, `limit`, `used` and `plan` here.
  A chat app refusal about settings or secrets carries the API's own `fields`
  list here: their names, never their values. Its hint repeats the names.

A hint may follow for statuses that need one. A `platform_image_required` or
`plan_limit` 403 gets its own hint rather than the general scope hint.
A 409 `skill_unavailable_licensing` says the store refuses the skill for its
licensing and where the catalog announces it, instead of the version hint. A
409 `skill_unavailable_unpublished` says the skill cannot be installed because
no release of it has been published, that no plan, scope, version or retry
changes that and there is nothing to buy, and where the listings show it; any
other `skill_unavailable_*` code gets the store's refusal in general terms. A
memory create or update refused with 409 `memory_limit` (the plan's remembered
items are used up; a Free plan keeps one, `limit` and `upgrade_plan` are in the
fields) names the delete tool that frees a slot, the update tool that changes
the item that exists, and the plan to move to; other memory refusals carry the
SDK's message alone.

## Request hints, embedded audio, and configuration merging

`thalovant_ask` accepts `sttLang`, an ordered `pipeline`, and `location`
with required `city` and optional `region`, `country`, `timezone`, `latitude`,
and `longitude`. Hints apply to the current request. Omit unused hints;
an empty pipeline is ignored, and blank language or city strings are rejected.

Ask and Query return language, ordered event metadata, `hasAudio` and
`droppedMedia`. Embedded hex stays out of text output. Opt into separate MCP
audio blocks with `includeAudio: true`; unknown formats become embedded binary
resource blocks. Clip and reply limits are 4 MiB and 16 MiB respectively,
checked by the SDK before retention. The client owns playback. No skill-supplied
path or URL is fetched. Inventory `speakable: true` renders examples without
changing the raw patterns; `slots` supplies illustrative slot values, and
`exampleLimit` limits examples per language to 1–20 (default 2).

Configuration updates default to `merge: true`: GET the revision, deep-merge
the caller's delta and PUT with `expected_revision`. Only HTTP 412 retries,
with a fresh read and at most three total attempts. This requires `hubs:read`,
`hubs:write`, and a paid plan. An older API without revision support fails before
writing. There is no unconditional fallback. Supplied personas replace;
omitted personas stay unchanged. For an intentional full replacement, pass
`merge: false`, requiring `hubs:write`, a paid plan, and coordination with other writers.
Guarded merges reject integers outside JavaScript's safe integer range in the
delta or stored configuration before writing. Store large identifiers as strings
or use an SDK that preserves large JSON integers.

## Destructive Tools

`thalovant_delete_hub`, `thalovant_delete_runtime_group`, `thalovant_delete_client` and `thalovant_delete_bridge` are **disabled by default**. They are not merely blocked when called — they are never registered, so they do not appear in `tools/list` and a model cannot see or attempt them.

A long-lived control-plane token combined with an always-available delete tool is a categorically different risk from a read or update tool: deleting a hub also deletes its dependent clients and ACLs, and none of it is reversible. So these are opt-in:

```bash
export THALOVANT_ENABLE_DESTRUCTIVE_TOOLS="true"
```

Accepted true values are `1`, `true`, `yes`, and `on`; anything else, including unset, leaves the tools off. The flag is read when a server instance is created. Restart the server process with the updated environment after changing it. `thalovant_config_status` reports the current state as `destructiveToolsEnabled` and lists the tools the flag controls.

This is a separate mechanism from the existing tool policy, deliberately. `MCP_TOOL_ALLOWLIST` / `MCP_TOOL_DENYLIST` and the per-principal `allowedTools` / `deniedTools` are call-time filters where an empty allowlist means "allow everything"; they cannot express a tool that is off until an operator turns it on, and they cannot hide a tool from `tools/list`. Once `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS` is set the delete tools are ordinary tools again and remain subject to that policy, so the two layers compose:

```bash
# Register delete tools, then deny their use by every principal.
export THALOVANT_ENABLE_DESTRUCTIVE_TOOLS="true"
export MCP_TOOL_DENYLIST="thalovant_delete_hub,thalovant_delete_runtime_group"
```

The global deny applies to every principal and cannot be overridden by a principal's `allowedTools`. To restrict only selected principals, leave these tools out of the global denylist and use those principals' `deniedTools` instead.

Deleting a hub still requires a current etag (`412` otherwise), and deleting a runtime group fails with `409` while it is the workspace default or still has hubs attached. Deleting a client cuts off the device or link using it; its etag is read first when none is given. Deleting a chat app bridge removes its stored token, so connecting the bot again means pasting the token in the console; to stop a bridge for now, pause it instead.

## Non-Catalog Skill Sources

`thalovant_install_runtime_group_skill` installs from the vetted marketplace catalog by default. Any other source — notably `sourceType: "git"` with an arbitrary `sourceRef` repository URL — pulls code the marketplace never reviewed straight into a production runtime, and the control-plane validator is format-only with no host allowlist. Because the tools are driven by a model holding a long-lived token, non-catalog sources are refused unless an operator opts in:

```bash
export THALOVANT_ENABLE_GIT_SKILL_SOURCES="true"
```

With the flag unset, a call with any `sourceType` other than `catalog` fails before any control-plane request is made. Accepted true values are `1`, `true`, `yes`, and `on`. `thalovant_config_status` reports the state as `gitSkillSourcesEnabled`. The tool is annotated `destructiveHint: true`.

## Read-Only Mode

Set `THALOVANT_MCP_READONLY=1` to register only tools annotated `readOnlyHint: true` (the sign-in tools are not among them; `thalovant_wait_for_admission` is), less those the API serves only to a write scope: `thalovant_list_bridge_chats` changes nothing but needs `hubs:write`, which an observe-only agent's token does not carry. Write and destructive tools are then never registered and never appear in `tools/list`, so an operator can run an observe-only agent without hand-writing a denylist. Like the other registration-time gates it is read when a server instance is created; `thalovant_config_status` reports the state as `readOnly`.

## HiveMind Runtime Compatibility

Runtime calls sharing the same hub client identity run sequentially within one
MCP process. Use a distinct client identity for each independently running MCP
server so the hub can keep their sessions separate.

Version 0.9.0 requires `@thalovant/sdk` `^0.11.0` (0.11.0 through versions below 0.12.0), which carries `browserLogin()` and `interactiveLogin()` for browser sign-in, as well as the chat app methods and `ThalovantApiError.fields`. Since 0.5.1 the server enforces
secure effective MQTT URLs and carries a single connection deadline through
MQTT setup and HTTP failure cleanup. Runtime tools support
HiveMind v3 Noise over WSS, HTTPS and MQTT over TLS. `thalovant_healthcheck`
reports readiness only after authentication; a reachable hub or broker alone
does not establish a runtime session.

The Zod 4 security migration preserves the 50 default tools and string-keyed record values. Its JSON Schema output inlines repeated records, identifies string property names, and omits `additionalProperties: false` on stripping objects; unknown input keys are still stripped before handlers receive them. UUID validation now enforces standard version/variant bits (plus nil/max UUIDs), and memory-list offsets must be safe integers. See the [security audit](https://github.com/thalovant/thalovant-mcp/blob/main/AUDIT.md) for evidence and release gates.

Keep the SDK configuration directory persistent and private between server
restarts (`~/.config/thalovant`, or the configured XDG/Windows equivalent). It
contains the client Noise key and trusted server pins. An authentication
failure preserves those pins; replacing a server key requires an explicit,
verified trust change. HTTPS identities must advertise the hub's HTTPS plugin,
and MQTT requires the identity's broker credentials and topic prefix.

Runtime tools retain their identity lease through actual cleanup. If the close
caller times out, a later tool waits up to six seconds for that cleanup before opening a session.
A queued tool that reaches this deadline fails without executing later or releasing
the previous session's identity.
An actual cleanup failure marks the identity unavailable to later calls instead
of risking concurrent sessions. These leases are process-local; separate server
processes or replicas need distinct runtime identities or external coordination.

MCP request cancellation applies to queued runtime tools in both stdio and
Streamable HTTP mode. A cancelled queued call never constructs a runtime client
or executes later. Cancellation also reaches runtime connection setup, Ask,
Query and event waits. Action/code sends, raw event publication and inventory
queries check cancellation during connection setup, then retain ownership until
the admitted SDK operation finishes. Cancelling the MCP request cannot undo an
already admitted operation or its effects. The identity remains reserved through
that work and actual cleanup; application requests are never automatically replayed.
Control-plane tools do not gain runtime cancellation semantics in this release.

For example, an MCP TypeScript client can cancel a runtime query after ten seconds,
including time spent waiting for its identity lease:

```typescript
await mcpClient.callTool({
  name: "thalovant_query",
  arguments: { identityFile: "/secure/identity.json", text: "What is the weather?", timeoutMs: 30000 },
}, undefined, { signal: AbortSignal.timeout(10000) });
```

Intent inventory retains its connection setup and per-query/batch budgets plus
a separate optional fallback probe; it has no single inventory-wide deadline.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run test:smoke
npm run test:http
npm run bench
npm run bench:http
npm pack --dry-run
```

## License

MIT. This is the right default for a public integration server: it is permissive, compatible with the MIT Thalovant Node SDK and MCP TypeScript SDK, and does not force downstream agent or enterprise users into a reciprocal licensing model.

Credential-bearing control-plane calls require HTTPS. Explicit loopback HTTP
(`localhost`, `127.0.0.1`, `[::1]`) remains supported for local development.
API redirects are rejected so password-login bodies cannot be forwarded.
Runtime clients are constructed only after acquiring their identity lease.

`thalovant_query` sends a routed HiveMind query; the hub may cascade it according
to its routing policy. It accepts `text`, `timeoutMs`, `lang`, `sessionId`,
`requestId`, `queryId`, `context` and `replySettleMs`, plus the runtime identity
options, and returns the same normalized reply shape as `thalovant_ask`. A query
may trigger actions, so read-only mode hides it. Conversation workflows use
`sessionId` with ask/query and the existing event-wait tool; MCP does not expose
one tool for every SDK conversation or event-listener method.


### Shared-runtime skill management

The catalog has 63 default tools, 30 in read-only mode, and 67 with destructive tools enabled; `THALOVANT_ENABLE_INTERCOM_ANNOUNCE` adds one.

Hub-addressed skill methods select the runtime group attached to the hub UUID.
Every hub sharing that group sees the same skill changes and history. The API
requires a restricted token to cover all served hubs. Reads need `hubs:inspect`
(`hubs:read` implies it); writes need `hubs:write`, an eligible paid plan and ownership.

The history response contains newest-first `event` and `operation` entries,
including nullable actor/version fields. Its limit is 1–200 (50 where omitted).
An accepted mutation is not proof the skill is ready. Optional waiting polls the
operation, with a 120-second default timeout and two-second interval. Polling
never repeats an accepted mutation and starts no new read after its deadline;
an already-running HTTP request retains its normal request timeout.

Read history with `thalovant_list_hub_skill_history` (`hubId`, optional `limit`). This tool remains available in read-only mode.


Inventory `sentence: true` implies speakable rendering and capitalizes/punctuates
examples using bundled thalovant-languages 0.2.1 rules. Regional locale matching
follows OVOS distances; explicit `slots` override locale sample values. Complete
phrases rank first, and `exampleLimit` counts unique nonempty rendered results.
Raw intent definitions remain in the response; unknown locales retain bare text.

The CLI handles SIGTERM and SIGINT in stdio and HTTP modes, including when it
runs as the container's PID 1. It closes sessions and HTTP connections before a
successful exit, with a ten-second failure deadline for stalled cleanup.

Version 0.5.1 uses Node SDK 0.7.1 with Python 0.7.4-compatible inventory
and question detection, including Unicode question marks and omitted-language patterns. With `sentence: true`, Spanish questions receive their question
mark and complete French phrases keep their final period. Undescribed
languages remain bare.
