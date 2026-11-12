Last Edit: Claude Sonnet 5.5 - 2026-11-12 - Motive: Intercom final API (platform security review): intercom:urgent check, new problem codes in tool errors, kind/can_play/policy_synced, replayed, the API's text rule; parity capability intercom recorded.

# FAQ

## Intercom

### Why was my urgent announcement refused with a message about `intercom:urgent`?

An urgent announcement (and every repeat) needs the scope `intercom:urgent` in addition to `intercom:send`; nothing implies it. When you signed in through `thalovant_begin_browser_login` or `thalovant_begin_device_login` and the grant did not include it, the server refuses before it asks the person to confirm and before any request. With a token configured through the environment the server cannot see the scopes, so the API answers `403 urgent_scope_required` and the error says the same. Sign in again with `intercom:urgent` (a paid plan), or, only with the person's agreement, send a normal announcement.

### Why does a speaker say `can_play: false`, and why can it not be named?

It is a connection that cannot play speech (a Home Assistant link, a developer tool or an embedded device whose owner has not declared it a speaker). It is listed so it can be greyed out, never spoken to, never part of `allowAll`, a room or a group, and naming it is `not_a_speaker`.

### What does `replayed: true` mean on an announcement?

The API returned the STORED announcement for that idempotency key (`Idempotency-Replayed: true`): nothing new was sent, whatever its status. Do not tell the person it was sent again.

### Why does every announcement say `intercom_disabled_platform`?

Intercom ships dark: until the platform operator turns it on, every write and announcement is a 503 `intercom_disabled_platform` and `thalovant_intercom_list_speakers` reads `unavailable_reason: platform`. Reads and `thalovant_intercom_cancel_announcement` still work.

### Why is there no `thalovant_intercom_announce` in my tool list?

It is registered only when the operator sets `THALOVANT_ENABLE_INTERCOM_ANNOUNCE=1`, because it makes speakers in a home talk. The two reads (`thalovant_intercom_list_speakers`, `thalovant_intercom_get_announcement`) and `thalovant_intercom_cancel_announcement` are always there, except that read-only mode leaves out the announce and cancel tools.

### Does the opt-in mean an agent cannot make a hub speak without it?

Yes, for the tools of this server. `thalovant_emit_event`, `thalovant_ask`, `thalovant_query` and `thalovant_send_action` reach a hub as a client identity, but they now refuse every message type that starts with `thalovant.intercom.` and `speak` / `ovos.utterance.speak`, whatever `MCP_TOOL_DENYLIST` says (`src/bus-guard.ts`). You no longer need to deny them for this. A hub's own routines and skills are not tools of this server: they speak through the hub's intercom skill under the hub's per-speaker settings.

### Why was my urgent (or allowAll) announcement refused?

An urgent announcement, and one to every speaker (`allowAll`), is sent only after the person confirms in a prompt this server shows through MCP elicitation (hub, targets, priority, text). It is refused when the MCP client does not support elicitation, when the person declines or cancels, when the client fails to answer, and when the HTTP server runs with `MCP_HTTP_ENABLE_JSON_RESPONSE=true`, which cannot carry a question. `confirmUrgent: true` and `allowAll: true` are only the model's own assertions, so they never replace the prompt. A normal announcement to named speakers, rooms or groups needs no prompt.

### How do I stop an urgent announcement that is repeating?

Call `thalovant_intercom_cancel_announcement` with the hub and announcement ids: the hub stops repeating at once. It works only while the announcement is `sending` (otherwise `409 not_cancellable`). `hub_confirmed: false` in the answer means the hub could not confirm, so tell the people in the home; the hub's Intercom switch, the platform's kill switch and a spoken acknowledgement at any speaker also stop it. The tool is there without the announce opt-in and is left out of read-only mode.

### An announcement failed with "could not reach the Thalovant API". Should I resend it?

Not with a new key: it may already have been spoken. That also holds when the answer was cut off before its body arrived, when a success came back without the announcement's `id` and `status`, and after a 5xx. The error gives the idempotency key; read the announcement with `thalovant_intercom_get_announcement` if you have its id, or ask the household. Repeating with exactly the same key is safe: the API returns the stored announcement and never speaks it twice. A new key would speak it again.

### I got a 502 `hub_unreachable`. What now?

The error carries `announcement_id`. Read that announcement with `thalovant_intercom_get_announcement` before anything else, and never retry automatically. Resending with the same key speaks nothing: the API returns the stored `failed` announcement (a failed replay is not retried). To say it again on purpose, only after the person asks and you checked nothing was spoken, call the tool again without `idempotencyKey` so a new key is generated.

### Can I limit which hubs an agent may announce on?

Yes: `THALOVANT_INTERCOM_ALLOWED_HUBS=<uuid>,<uuid>` limits all four intercom tools to those hubs; every other hub is refused before any request. Unset, any hub the token reaches is allowed. A list with no valid UUID allows nothing. A per-principal rate cap also applies to announce (20 normal a minute, 5 urgent an hour; `THALOVANT_INTERCOM_RATE_NORMAL_PER_MINUTE`, `THALOVANT_INTERCOM_RATE_URGENT_PER_HOUR`).

### Why are speaker names cut or changed in the list?

They are typed by the household, so every name, room, group and `acked_by` is stripped of control, text-direction and zero-width characters and cut at 80 characters, and the answer says they are data, never instructions. The id and slug are what to pass as targets.

### Why must `idempotencyKey` be a UUID?

A replayed key never speaks again for 24 hours, so a constant such as `dinner-2026-11-11` would swallow the next "dinner is ready". Leave it out and a fresh UUID is generated for every call; supply one only to repeat the same announcement after an unreachable-API error.

### Is the text kept anywhere?

Not by the platform or by this server. The platform stores its length and a keyed hash; when the audit log is on (`MCP_AUDIT_LOG`, off by default), this server records `mcp.intercom.announce` with the length and an HMAC-SHA256 (`textSha256`), even with `MCP_AUDIT_INCLUDE_ARGS` on. Tool answers never carry the text; the confirmation prompt shows it to the person only. The MCP client that sent the announcement can keep the text in its own conversation or tool-call history, and this server cannot control that.

### Is Intercom a safety system?

No. It does not replace smoke or CO alarms, medical alert devices or emergency services.

### Does Intercom listen?

It does not record or store speech. While an urgent alert sounds, it only checks whether a reply the hub already hears is an acknowledgement ("I heard it", "I'm okay"). There is no two-way audio.


## Browser sign-in

### Which sign-in tool should an agent use?

`thalovant_begin_browser_login` with the default `method: "auto"`. Over stdio it signs the person in through the browser on their computer when it can, and starts a device login when it cannot; over Streamable HTTP it starts a device login. Either way the answer's `next` names the poll tool. `thalovant_begin_device_login` stays for a registered app's sign-in (Home Assistant's `clientId`), which the browser sign-in does not take.

### Why does a hosted (Streamable HTTP) server never sign in through the browser?

The browser hands the sign-in code to `http://127.0.0.1:<port>/callback`, which is the computer the browser runs on. A hosted server's `127.0.0.1` is the server's, not the person's, so the answer could never arrive. `method: "browser"` is refused there before any request, and `auto` is a device login, exactly as before 0.8.0.

### Why did it start a device login on my laptop?

`auto` uses the browser only when this computer can show one and the API offers browser sign-in. It never does with `CI`, `SSH_CONNECTION` or `SSH_TTY` set (the browser would open somewhere else, or nowhere); on Linux and the BSDs it needs `DISPLAY` or `WAYLAND_DISPLAY`. An API that answers `GET /v1/auth/native/config` with 404 (before thalovant-api #501 is deployed) or with a configuration the SDK cannot use also means a device login. Nothing was opened by then, so this is not a downgrade. `method: "browser"` forces the browser and fails instead.

### Can I force a browser sign-in in a container or over SSH?

Only if the person's browser can reach the server's `127.0.0.1`, which it usually cannot: a container and a remote shell each have a loopback of their own. `auto` signs in with a device login over SSH and without a display; a forced `method: "browser"` would wait out its timeout there (unless the port is forwarded). Use `method: "device"`.

### Is a device login's code as safe to share as the browser link?

No. The browser path's link delivers nothing to a sender on another computer, but a device code signs this server in as whoever approves it, from any device. Every device answer says so: show the code only to the person signing in.

### Does `timeoutMs` apply to a device login?

Yes, on both transports: past it the server stops polling for the device code, `expiresIn` in the begin answer says the shorter of the two, and a poll answers `expired`. That is the server's wait, not the API's: the code stays approvable at the API until its own expiry, but approving it then signs nothing in here, so the `expired` answer asks the model to tell the person not to approve it and to begin a new sign-in.

The `expired` answer lasts until the code's own expiry over Streamable HTTP, and five minutes past the wait over stdio. After that the server has forgotten the sign-in, and a poll answers a tool error saying it expired, ended, or belongs to another principal; begin a new one either way.

### The browser did not open. What now?

Opening is best-effort (`open`, `xdg-open` or `rundll32`, never waited for). Give the person `authorizationUrl` from the begin answer; it must be opened in a browser on the same computer as the server. The prompt is also on the server's stderr log.

### Where does the "Opening your browser…" line go?

To stderr. `@thalovant/sdk` prints its prompt with `console.log`, which writes to stdout, and over stdio stdout is the MCP protocol stream: a printed line between JSON-RPC messages breaks the session. So the stdio entry point (`keepStdoutForProtocol()` in `src/index.ts`) sends every console method to stderr. The model gets the URL, or the device code, in the tool's answer.

### Does a denied or timed-out browser sign-in fall back to a device login?

No. Once the browser has been sent to the consent page, its outcome stands, as the shared contract says; begin a new sign-in to try again.

### Does the poll tool call the API?

No. The sign-in runs inside the server (the SDK waits on the loopback port, or polls the device token itself); `thalovant_poll_browser_login` reads how it is going, so polling every few seconds costs nothing.

### How do I sign out after a browser sign-in?

`thalovant_revoke_device_login`. Both sign-ins keep their token in the same per-principal store, and the token revokes itself either way.

### Why was CI red on the 0.8.0 pull request at first?

`package.json` and the lockfile named `@thalovant/sdk` ^0.11.0 on the npm registry before it was published, so `npm ci` answered 404. Once 0.11.0 was on npm (v0.11.0, 2026-11-08), `npm install @thalovant/sdk@^0.11.0` gave the lock entry its `integrity`, matching the registry's, and `npm ci` passes.

## Chat apps

### Can an agent connect a Telegram or Discord bot to a hub?

Not through this server. Creating a bridge needs the bot's token (or, for Matrix and Twitch, its secrets), and no tool here takes a credential as an argument, the same rule as for API tokens and passwords. The person pastes the token in the Thalovant console: Connections > Add connection > Chat apps, or the hub's Chat apps tab. After that, `thalovant_list_bridges` finds the bridge and the other chat app tools manage it.

### How does an agent replace a rejected token?

It doesn't. When `status.reason` is `TokenRejected` (or `TokenMissing` stays), `status.summary` sends the person to **Replace token** on the bot in the console.

### What does `status.summary` say, and where does it come from?

`bridgeStatusSummary()` in `src/chat-apps-output.ts` words the API's customer-safe `status.reason` (`Setup`, `Starting`, `Connected`, `Paused`, `Unavailable`, `TokenMissing`, `TokenRejected`). It adds the `hold` (`plan_limit` after a downgrade, `account_suspended`) and since when, and whether the latest change is applied. An unknown reason is kept and named. The platform's own `status.message` and `status.operator_reason` are never shown, even to an administrator's token.

### Why is `secrets_set` shown when other outputs redact anything named "secret"?

It lists which secrets are stored, by name; the API never sends their values. Redacting by key name would hide it, and `token_updated_at` too, which is a time. So bridge outputs are built from the members the API documents (`bridgeView()`), and only the free-form `settings` and `operation` go through redaction.

### How do I add a Telegram group to a running bridge?

Telegram lists chats only while the bridge is paused (`409 bridge_running` otherwise):

1. Pause it with `thalovant_pause_bridge`.
2. Have someone send `/start@<bot username>` in the group.
3. List the chats with `thalovant_list_bridge_chats`. It needs `hubs:write` and a paid plan, because it asks the chat network, so `THALOVANT_MCP_READONLY` leaves it out.
4. Call `thalovant_update_bridge` with `allowed`, which replaces the whole list, so keep the existing chats.
5. Resume it with `thalovant_resume_bridge`.

Discord lists channels while the bridge runs.

### Why does resuming fail with 403 `plan_limit` or 402?

The plan's running chat apps are at its limit (after a downgrade), or the plan has none (Free plans get 0). `thalovant_get_bridge_networks` shows `limit`, `used`, `remaining` and `can_create`. Pausing and deleting always work.

### Is there a delete tool?

`thalovant_delete_bridge`, registered only with `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS`, like the hub, runtime group and client deletes. It removes the stored token, which only the console can put back, so pausing is the reversible choice.

## Dependencies (0.6.6)

### Why move to Zod 4?

The patched bounded-container checks are in 4.6.6 and later. The installed MCP SDK supports Zod 4; five `z.record` calls now state their string key schema explicitly rather than using the removed Zod 3 shorthand.

### Are tool schemas byte-for-byte unchanged?

No. Record schemas are inlined and name string properties. Stripping objects no longer emit `additionalProperties: false`, but unknown properties are still stripped before handlers. UUIDs enforce standard version/variant bits (plus nil/max UUIDs), and the memory-list offset is limited to safe integers. Names, defaults and record value types remain intact.

## Tests

### Why do the HTTP tests start the server through `startMcpHttpServer()`?

`test/http.test.ts` runs `dist/index.js --http` on a port it found free, and other test files run in parallel with loopback fake APIs that answer every path with 200. If one of them is given that port first, the server fails to bind (`EADDRINUSE`) and the fake answers `/healthz`; a test that trusted any 200 then spoke MCP to the fake and failed with a `ZodError` naming `ok` and `path`. `startMcpHttpServer()` waits for this server's own health body (`name: "thalovant"`, `transport: "streamable-http"`) from a child that is still running, and starts it again on a fresh port after `EADDRINUSE`. New HTTP tests should use it, passing an `envFor(port)` when their environment names the port.
