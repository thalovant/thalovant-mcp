Last Edit: Claude Opus 5.5 - 2026-11-07 - Motive: Add the HTTP test startup question; keep the chat apps and Zod 4 answers.

# FAQ

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
