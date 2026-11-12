Last Edit: Claude Sonnet 5.5 - 2026-11-12 - Motive: Intercom final API (platform security review): intercom:urgent check, new problem codes in tool errors, kind/can_play/policy_synced, replayed, the API's text rule; parity capability intercom recorded.

# Changelog

## 0.9.0 - 2026-11-11

Intercom, the final API (platform security review; nothing here changes the version, 0.9.0 is not released):

- **The scope `intercom:urgent`.** An urgent announcement (and every repeat) needs it in addition to `intercom:send`. When this server knows what a sign-in was granted (a token minted by `thalovant_begin_browser_login` or `thalovant_begin_device_login`; the granted scopes are kept with the sign-in) and it lacks `intercom:urgent`, `thalovant_intercom_announce` refuses before the person is asked to confirm and before any request (audit `refused`, `reason: urgent_scope_missing`). For a token configured through the environment or a credential the scopes are not visible, so the API's `403 urgent_scope_required` is the check. Tool descriptions, README, QUICK_FACTS and FAQ name the scope.
- **Speakers**: `thalovant_intercom_list_speakers` shows `kind`, `can_play` (false: listed, never spoken to, never part of `allowAll`, a room or a group), `policy_synced` and `unavailable_reason` (now also `platform`), all cleaned; the summary says how many cannot play speech and that a change may take a moment to reach the home. **Announcements**: a delivery's `detail` code, `delivery_note` (delivered is not heard: there is no playback receipt; failed is not proof nothing was spoken), and `replayed: true` with a summary line when the API returned the stored announcement for the key (`Idempotency-Replayed: true`; the audit row says `replayed: true` beside `status: sent`).
- **New problem codes in tool errors**, each with a next step and never retried: `urgent_scope_required`, `intercom_urgent_busy` (`scope` hub or platform; cancel one or wait), `skill_not_installed`, `not_a_speaker` (the connections), `too_many_targets` (`matched`), `hub_locked`, `impersonation_not_allowed`, `intercom_unavailable` (`reason`), `intercom_disabled_platform`, `intercom_not_configured`, `managed_client`, `reserved_name`, `not_cancellable` (names the announcement's current status), a 409 for a key reused with a different request, and the existing `hub_unreachable` with `announcement_id`. Words taken from a problem (`scope`, `reason`, `announcement_status`, `not_speakers`) are cleaned and bounded before they reach a hint.
- **The text rule is the API's**: NFC-normalised, trimmed the way the API trims, 1-280 characters, and no `<` `>`, control, bidirectional or other invisible format characters (zero-width joiner and non-joiner allowed), lone surrogates, private-use characters or separators; an error never repeats it. `lang` must be a language tag.
- The parity file records the `intercom` capability (required) against the Python reference digest `69badc4fb072`.

Intercom: an agent can see a hub's speakers, follow and stop an announcement, and, when the operator opts in, say a short text aloud in a home. Intercom is not a certified safety system: it does not replace smoke or CO alarms, medical alert devices or emergency services.

- **`thalovant_intercom_list_speakers`** and **`thalovant_intercom_get_announcement`** (read-only, `intercom:read`): speakers with `online`, `receive`, `room`, `groups` and do-not-disturb; an announcement's status (now also `cancelled`) and each speaker's result in words. Output is whitelisted; no text.
- **`thalovant_intercom_cancel_announcement`** (`intercom:send`; `POST /v1/hubs/{hub}/intercom/announcements/{id}/cancel`): stops an announcement that is still `sending`; the answer carries `hub_confirmed` (false: the hub could not confirm, so tell the household). A write tool (idempotent, `destructiveHint: false`, only stops speech), registered whenever read-only mode is off, with or without the announce opt-in; a 409 `not_cancellable` is explained. Called through `src/intercom-sdk.ts` because the Node SDK's method is not released yet.
- **`thalovant_intercom_announce`**, registered only with `THALOVANT_ENABLE_INTERCOM_ANNOUNCE=1` (`intercom:send`), now `destructiveHint: true`. Text 1-280 plain characters (no control characters, line breaks, text-direction marks or `<` `>`); explicit targets (`speakers`, `rooms` or `groups`, one kind per call; `allowAll: true` for every speaker and nothing else); `priority: "urgent"` repeats (`repeatTimes` 1-10, `repeatIntervalSeconds` 5-120, refused without `repeatTimes`) and needs `confirmUrgent: true`.
- **A person confirms urgent and `allowAll`.** Both now need MCP elicitation (`elicitInput`): the person is shown the hub id, the targets, the priority and repeats, and the text, and the announcement goes out only on an explicit yes. A client without elicitation, a decline, a cancel, a client error or an HTTP server in JSON-response mode refuses it, and nothing is sent. `confirmUrgent` and `allowAll` remain as extra checks (they are the model's own assertions and never replace the prompt). A normal announcement to named speakers, rooms or groups asks nobody.
- **`thalovant_emit_event`, `thalovant_send_action`, `thalovant_ask` and `thalovant_query` can no longer carry the hub's Intercom protocol or speech**: any message type that starts with `thalovant.intercom.`, and `speak` and `ovos.utterance.speak`, is refused, whatever `MCP_TOOL_DENYLIST` and the intercom opt-in say. `thalovant_emit_event` refuses its `eventType` before it connects; every runtime client the server creates (those four and `thalovant_send_code`) has its transport guarded by type (`src/bus-guard.ts`), and a call fails rather than run unguarded. This replaces the earlier advice to deny all four tools; `thalovant_config_status` drops `intercomGateNote` and reports `intercomGuardrails`.
- **Hub allowlist.** `THALOVANT_INTERCOM_ALLOWED_HUBS` (comma-separated hub UUIDs; unset means any hub the token reaches) limits all four intercom tools; a list with no valid UUID allows nothing.
- **Per-principal rate cap on announce:** 20 normal announcements a minute and 5 urgent ones an hour by default (`THALOVANT_INTERCOM_RATE_NORMAL_PER_MINUTE`, `THALOVANT_INTERCOM_RATE_URGENT_PER_HOUR`), on top of the API's per-hub limits. A declined announcement does not count; cancel and the reads are not capped.
- **Idempotency.** Every call generates a fresh UUID key; a caller-supplied `idempotencyKey` must be a UUID. A replay returns the stored announcement and never speaks it again, whatever its status (24 hours), so a key is not reused for another announcement. The announce call is never retried: after an unreachable API, a cut-off body, a success without `id` and `status`, or a 5xx, the error names the key and says that repeating with exactly that key is safe. After a **502 `hub_unreachable`** the error carries the problem body's `announcement_id` and says to READ the announcement before any resend and never to retry automatically; saying it again on purpose needs a new key.
- **Household labels are data.** Speaker names, rooms, groups, `acked_by` and every other string the API sends in an Intercom answer are stripped of control characters and text-direction, zero-width and other format marks and cut at 80 characters, and each answer carries a note that they are labels, never instructions. Characters of the API's own words in an Intercom error are cleaned the same way.
- **Audit.** `mcp.intercom.announce` records `textLen`, `textSha256`, `targets`, `priority` and the outcome (`sent`, `error`, or `refused` with a `reason`), `mcp.intercom.cancel` the cancel, when `MCP_AUDIT_LOG` is on (it is off by default). `textSha256` is now an HMAC-SHA256 (`THALOVANT_INTERCOM_AUDIT_HMAC_KEY`, else a random key of the process), so a short sentence cannot be confirmed from the log. Neither the platform nor this server stores or audits the text; an MCP client may keep it in its own history, and the confirmation prompt shows it to the person only.
- The adapter refuses empty, `.` and `..` ids (a dot segment survives percent-encoding).
- Wording: Intercom does not record or store speech, and while an urgent alert sounds it only checks whether a reply the hub already hears is an acknowledgement; stopping is by the cancel tool, the hub's switch, the platform kill switch and a spoken acknowledgement, not "at once" by any one of them.
- The catalog has 64 default tools (30 in read-only mode, 68 with destructive tools enabled; one more with the Intercom opt-in).
- **Dependency, unreleased:** the Intercom routes (four functions) are called through `src/intercom-sdk.ts` until `@thalovant/sdk` publishes its intercom methods; the lock is unchanged.
- `package.json`, `package-lock.json`, `server.json`, the OCI label, the README and this file move to 0.9.0 together. The parity contract refreshes the evidence hashes of `src/index.ts`, `test/http.test.ts` and `test/provisioning.test.ts`.

## 0.8.0 - 2026-11-08

A person can now sign the server in through the browser on their own computer: a link or code sent to someone on another computer delivers nothing to the sender. That holds for the browser path only; device sign-in is unchanged, and its code still signs the server in as whoever approves it.

- **`thalovant_begin_browser_login`** and **`thalovant_poll_browser_login`**. Over stdio the begin tool runs `interactiveLogin()` of `@thalovant/sdk` (the authorization code grant with PKCE on a `127.0.0.1` loopback redirect, RFC 8252) in the background and answers as soon as the person has something to open. `method: "auto"` (the default) signs in through the browser when this computer can show one (not with `CI`, `SSH_CONNECTION` or `SSH_TTY` set; macOS and Windows yes; elsewhere with `DISPLAY` or `WAYLAND_DISPLAY`) and the API offers it, and otherwise starts a device login, answered with the code to show; `browser` and `device` force one. The browser answer carries `authorizationUrl` and the server opens it with the platform's opener (`open`, `xdg-open`, `rundll32 url.dll,FileProtocolHandler`, never a shell). The poll tool asks the server, not the API: `pending`, `approved`, `denied`, `expired` or `error` with the api-errors fields, and `method`. The browser must share the server's `127.0.0.1`, which a stdio server over SSH (without port forwarding) or in a container does not; the descriptions and README say to use `method: "device"` there. Every device answer, here and from `thalovant_begin_device_login`, tells the model to show the code only to the person signing in. Inputs: `method`, `scopes`, `deviceName` (default `thalovant-mcp on <hostname>`, at most 120 characters; an empty string sends none, keeping the hostname off the consent page) and `timeoutMs` (1000-900000; default 300000 for the browser, 900000 for a device login; it also ends a device login before its code expires, over Streamable HTTP too, where `thalovant_poll_device_login` then answers `expired` until the code's own expiry, and `expiresIn` reports the shorter of the two; the code stays approvable at the API until then, so that answer asks the person not to approve it).
- **Over Streamable HTTP, device login exactly as before.** A hosted server's `127.0.0.1` is not the person's computer, so `method: "browser"` is refused before any request, and `auto` or `device` start a device login the way `thalovant_begin_device_login` does, polled with `thalovant_poll_device_login`. `createServer()` takes `{ transport: "stdio" | "streamable-http" }`; the CLI passes the one it runs, and an embedder that passes none gets `streamable-http`.
- **The stdio protocol stream carries only the protocol.** The SDK prints its sign-in prompt with `console.log`, as a command line wants; the stdio entry point now sends every console method to stderr, the server's log, so no printed line can land on stdout between JSON-RPC messages. The tool's answer carries the URL or the code for the model.
- **One token store for both sign-ins.** An approved browser sign-in's token is kept server-side for the principal that began it, used at once by every control-plane tool when nothing is configured, and signed out with `thalovant_revoke_device_login`, whose description and refusal now name both sign-ins. `thalovant_config_status` adds `transport` and `browserLoginAvailable`; `deviceLoginSignedIn` is true after either sign-in.
- Descriptions and hints that sent every sign-in to `thalovant_begin_device_login` now name the browser sign-in too: the device tool's description, the 401 hint after a refused connection call, and the error an unauthenticated control-plane tool raises.
- The catalog has 61 default tools (28 in read-only mode, which registers neither new tool; 65 with destructive tools enabled).
- Takes `@thalovant/sdk` ^0.11.0 (published 2026-11-08; the lock resolves 0.11.0 with its registry `integrity`), which carries `browserLogin()`, `interactiveLogin()`, `canOpenBrowser()` and the browser sign-in vectors' behaviour.
- The parity contract declares `browser-login` as required, with `test/browser-login-vectors.json` (119 cases) vendored from the Python reference and run through the SDK and through the tools over stdio; it acknowledges the final candidate reference digest `6dfb3bb31ac7` beside the current `57c7e71f6456`, and refreshes the evidence hashes of `src/index.ts` (every capability that names it) and `test/provisioning.test.ts`.
- `package.json`, `package-lock.json`, `server.json`, the OCI label, the README and this file move to 0.8.0 together.
- **The HTTP transport tests no longer take another test's port.** `test/http.test.ts` found a free port, released it and started the server on it, and a loopback fake API from another test file, running in parallel, could be given that port in between: the server then failed to bind, the fake answered `/healthz` with 200, and the test talked MCP to it (a `ZodError` naming `ok` and `path`, seen once on `main`'s Node 20 job). The tests now start the server through `startMcpHttpServer()`, which counts only this server's own health body (`name: "thalovant"`, `transport: "streamable-http"`) from a child that is still running, and starts it again on a fresh port when the child lost its port (`EADDRINUSE`). A new test hands the helper a port another server holds first and checks that the session lands on a fresh one. Test-only; nothing the package ships changes.
- The parity contract refreshes the evidence hash of `test/http.test.ts` (identity and chat-apps capabilities).
- This file's 0.7.1 entry no longer lists the real-transport test's 90 s budget: it merged after the `v0.7.1` tag, whose `test/runtime-noise.test.ts` still has 30 s, so the 0.7.2 entry lists it.

## 0.7.2 - 2026-11-07

- **A skill with no published release is explained by its code.** thalovant-api#495 adds a second reason the store refuses a skill: `unpublished`, when no installable release of it exists. Installing one answers 409 `skill_unavailable_unpublished` with `reason: unpublished`, before any paid-plan 402, and it got the generic 409 hint, which talks about a version already installed. It now says the skill cannot be installed because no release has been published, that no plan, scope, version or retry changes that and there is nothing to buy, that a non-admin token does not see it in `thalovant_list_marketplace_skills`, and that `thalovant_list_runtime_group_marketplace` lists it only for a group that already has it, with `unavailable_reason` and `installable` and `purchase_required` false. Any other `skill_unavailable_*` code gets the store's refusal in general terms instead of the version hint. `thalovant_list_runtime_group_marketplace`'s description names the field. Three tests drive the hub and runtime-group installs and an unknown code through the fake control plane.
- The parity contract refreshes the evidence hashes of `src/index.ts` and `test/provisioning.test.ts`.
- **The real-transport test gets a 90 s budget** (merged after the `v0.7.1` tag, so first released here; test-only). `test/runtime-noise.test.ts` opens eight HTTPS sessions against a local hub, each with its own Noise handshake over a polled connection, and takes about 22 s on a workstation; its 30 s budget ran out on a shared runner twice (`main`, 2026-11-03 and 2026-11-06), passing on the rerun both times. The budget is for the runner, not the calls: every call keeps its own `timeoutMs`, and no assertion changes.
- `package.json`, `package-lock.json`, `server.json`, the OCI label, the README and this file move to 0.7.2 together.

## 0.7.1 - 2026-11-06

- **Two refusals explained by their code.** A skill the store does not install for licensing reasons (YouTube, YouTube Music, Spotify, SoundCloud and Bandcamp; the API's 409 `skill_unavailable_licensing` with `reason: licensing`, declared with the launch data-protection change) got the generic 409 hint, which talks about a version already installed. It now says the service's terms do not allow a hosted assistant to play its content, that no plan, scope, version or retry changes that, that radio and aggregator skills install as usual, and that `thalovant_list_marketplace_skills` reports it per skill as `unavailable_reason` and `installable`. A memory create or update refused with 409 `memory_limit` (the plan's remembered items are used up; a Free plan keeps one) carried no hint at all, because the memory tools never went through the hint path; `thalovant_create_memory_item` and `thalovant_update_memory_item` now do, under a profile of their own that adds a hint for that code alone (the hub-centric scope and plan hints would misdescribe the memory routes), naming the `limit` and `upgrade_plan` fields, the delete tool that frees a slot, the update tool that changes the item that exists, and that granting a scope will not help. Two tests drive both through the fake control plane.
- `package.json`, `package-lock.json`, `server.json`, the OCI label, the README and this file move to 0.7.1 together.

## 0.7.0 - 2026-11-03

A hub can answer in a chat network through a chat app: Telegram and Discord, and Matrix, Mattermost and Twitch as beta once the API lists them. These tools let an agent read and look after the bridges a person connected in the console. Existing tool schemas are unchanged.

- **Reads:** `thalovant_list_chat_app_connectors` (status, setup steps in `en` or `fr`, the secrets the console asks for by name, the settings form, chat id format, helpers), `thalovant_get_bridge_networks` (networks offered and the plan's allowance, with a `summary`; Free plans get 0), `thalovant_list_bridges`, `thalovant_get_bridge` and `thalovant_list_bridge_chats`. All five change nothing. The first four need `hubs:read` and stay in `THALOVANT_MCP_READONLY` mode. `thalovant_list_bridge_chats` asks the chat network on the bot's behalf, so the API serves it only to `hubs:write`, the hub's owner or a manager, and a paid plan; read-only mode leaves it out.
- **Status in plain words.** Each bridge's `status` keeps the API's `reason`, `phase`, `ready` and `applied`, and adds `summary`: what `Setup`, `Starting`, `Connected`, `Paused`, `Unavailable`, `TokenMissing` or `TokenRejected` means and what to do, a `plan_limit` or `account_suspended` hold and since when, and whether the latest change has reached the bridge. A reason this server does not know yet is kept and named. The platform's own diagnostic message (`status.message`, `status.operator_reason`) is never included, even for an administrator's token.
- **Writes:** `thalovant_pause_bridge` and `thalovant_resume_bridge` (`PATCH paused`), `thalovant_update_bridge` (`allowed`, which replaces the whole list, `requireMention`, `sessionScope` and non-secret `settings`) and `thalovant_send_bridge_test_message`. Each takes an optional `etag`, sent as `If-Match` only when given.
- **Tokens and secrets stay in the console.** No tool takes a credential as an argument, so creating a bridge and replacing its token or secrets have no tool; descriptions and outputs say where to go (Connections > Add connection > Chat apps, or the hub's Chat apps tab, and **Replace token**). `thalovant_update_bridge` refuses a setting whose name looks like a token or secret, at any depth, before any request, naming it by its dotted path without its value.
- **`thalovant_delete_bridge`**, opt-in with the other destructive tools (`THALOVANT_ENABLE_DESTRUCTIVE_TOOLS`): it removes the bridge and its stored token, which only the console can put back.
- **Outputs are allowlisted.** Bridges, connectors, chats and the allowance are built from the members the API documents, not passed through; the owner's `settings` and a queued `operation` go through the usual redaction. Redacting whole bridges by key name would have hidden `secrets_set` and `secrets` (names) and `token_updated_at` (a time).
- **Hints by code** after a refused chat app call: the settings a `bridge_settings_invalid` or `bridge_url_*` refusal names (from the SDK's new `ThalovantApiError.fields`, names only), Telegram's pause-to-list rule (`bridge_running`), the plan's allowance after `402` or `403 plan_limit`, the wait after a `429`, a stale `etag` (`412`), a bridge the token cannot see (`404`), and the console for every token or secret code.
- The catalog has 59 default tools (28 in read-only mode, 63 with destructive tools enabled).
- Takes `@thalovant/sdk` ^0.10.0, which carries the chat app methods and `ThalovantApiError.fields`.
- The parity contract declares `chat-apps` as required and refreshes the evidence hashes of `src/index.ts`, `test/http.test.ts` and `test/provisioning.test.ts`.
- `package.json`, `package-lock.json`, `server.json`, the OCI label, the README and this file move to 0.7.0 together.

## 0.6.6 - 2026-10-26

- Update body-parser to 2.4.0 (CVE-2026-111181), Zod to 4.6.7 (patched bounds checks from 4.6.6), and the existing fast-uri override to 3.1.9. No audit suppression is added.
- Migrate five records to Zod 4's explicit string-key signature. Bounded arrays reject oversized input before parsing elements. UUIDs now enforce standard version/variant bits (plus nil/max UUIDs); memory-list offsets reject unsafe integers.
- Preserve the 50 default tools, Thalovant SDK version, permissions and transport behavior. Zod 4's generated input schemas inline repeated records, add string property names and omit the previous `additionalProperties: false` on stripping objects; unknown input keys remain stripped at runtime.
- Align package, registry and OCI metadata at 0.6.6. Publication, published-artifact smoke checks and deployment remain separate release steps.

## 0.6.5 - 2026-10-23

- Lock the runtime transitive dependency `ip-address` to 10.7.4, fixing the IPv6 zone-identifier parsing denial of service (CVE-2026-111997). The MCP and Thalovant SDK versions, tool schemas, and protocol behavior are unchanged.
- Update development dependencies Vite to 8.3.3 and Vitest with its matching packages to 4.1.12, fixing CVE-2026-112942, CVE-2026-112949, and CVE-2026-112950. Neither Vite nor Vitest is included in the production OCI runtime.
- Align `package.json`, `server.json`, the OCI label, and the README at 0.6.5. Existing release security checks and published-artifact smoke checks remain unchanged.

## 0.6.4 — 2026-10-19

- **Descriptions that say what a runtime tool changes.** `thalovant_send_action`, `thalovant_send_code` and `thalovant_wait_for_event` had one-line descriptions that didn't say whether the tool changes anything. A scanner that reads only names and descriptions rated all three as high-risk tools that execute, `thalovant_wait_for_event` included, though it was already annotated `readOnlyHint: true`. `thalovant_send_action` now says the hub routes its payload like a spoken request, so a skill may act on it. `thalovant_send_code` says the hub receives its value as an exact utterance, and both say they return without waiting for a reply and that `THALOVANT_MCP_READONLY` leaves them out. `thalovant_wait_for_event` says it only listens and sends the hub nothing, and that `sessionId`, `requestId` and `context` filter which events count. `payload`, `title`, `value`, `kind`, `label` and `eventName` now have their own descriptions. Schemas, annotations and behaviour are unchanged.
- The Claude Desktop and Codex examples start the published package with `npx -y @thalovant/mcp-server`. They used to point at a path on one developer's machine.
- `package.json`, `server.json`, the OCI label, the README and this file move to 0.6.4 together.

## 0.6.3 — 2026-10-11

- **Sentences in the language the hub answers in.** `thalovant_intent_inventory` takes `@thalovant/sdk` 0.9.9, which lists a language the hub never loaded in one of the hub's own languages: the same language in another region first, then the hub's own language, then the one with the most sentences. A hub loads its `lang` and `secondary_langs` and lists nothing under any other tag, so on 2026-10-11 a ja-JP, es-ES or de-DE request came back empty on every public hub, even though the hub answers those people. The output's `listed_in` names the language each requested language was listed in. `examples` are now rendered from that language (they used to be rendered from the requested tag and came back empty). `presentation.notes` says when the sentences are in another language, so an agent can tell the user.
- **Fallback skills that exist.** The SDK reads fallbacks from `ovos.skills.list` and no longer asks `ovos.skills.fallback.list`, which ovos-core reverted the day it landed. Skills with no intents, such as Daily Desk's memory skill, now appear. `priority` is `null`: the hub does not say in which order it tries fallbacks, and the list is in skill id order. The tool description and README say so. A connection needs `ovos.skills.list` on its allow-list; until then fallbacks stay unknown, as before.
- Takes `@thalovant/sdk` ^0.9.9, and the lock resolves the published 0.9.9. The parity contract acknowledges reference digest `5b973a65ab58` (see thalovant/thalovant-python-sdk#105).
- `package.json`, `server.json`, the OCI label, the README and this file move to 0.6.3 together.

## 0.6.2 — 2026-10-02

- Takes `@thalovant/sdk` ^0.9.3, which the lock resolves. Its `reply.claimed` now recognizes a skill's own confident fallback-tier answer; the earlier range silently swallowed a genuinely successful Home Assistant reply (a `claimed` answer from the home skill's fallback tier read as "nothing answered"). No code change in this package: the logic is the SDK's `replyClaimMetadata`, which `src/reply-output.ts` delegates to.
- The parity contract acknowledges the reference's final round-two digest, and the vendored `reply-claim-vectors.json` carries the round's cases with each event's name and meta, so the assertion-on-a-non-speak-event-is-ignored case is actually exercised rather than built as a bare `speak`.
- `package.json`, `server.json`, the OCI label and this file move to 0.6.2 together, so the release inventory's `compatible_node_sdk` can follow `package.json` to `@thalovant/sdk ^0.9.3`: the platform contracts gate compares the two byte for byte, and the dependency moved on 2026-09-30 without a release to record it.

## 0.6.1 — 2026-09-28

- **Sign in as a registered app.** `thalovant_begin_device_login` takes an optional `clientId`, passed to the API as `client_id` only when given: `thalovant-home-assistant` makes the approval page show the platform's name for Home Assistant as verified, and approving it again replaces the token it already holds. An id the API does not know is refused with 400 `unknown_client`, and the tool error carries the code and sentence like any other refusal.
- **An echoed validation input never reaches a tool error.** The `fields:` line of a tool error printed a validation error's `input` whenever it was a bare string or sat under an ordinary key: the secret redaction matches key names only. Each entry of a `detail` or Problem+JSON `errors` list now has its `input` replaced with `"[omitted]"` before redaction, whatever its key or shape.
- **Where the Noise key lives.** `@thalovant/sdk` 0.9.1 keeps an identity file's Noise key and hub pins in that file's folder, so every program reading the file presents one key, and copies them there once from the shared folder when that key already met the hub. Runtime tools given an `identityFile` follow it.
- Takes `@thalovant/sdk` ^0.9.1, which carries `clientId`, `describeDeviceLogin()`, the refused-client-key error and the key folder. The lock resolves the published 0.9.1.
- `fast-uri`, which `ajv` brings in, is overridden to 3.1.8: 3.1.6 now carries two high advisories (GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g), and 3.1.8 still satisfies `ajv`'s `^3.0.1`.
- The parity contract acknowledges the reference's `3b0acf7c8b2f` and declares its new `link-carriers` capability not applicable: this server's carriers are the Node SDK's, which runs those vectors. The re-vendored `api-error-vectors.json` and `device-login-vectors.json` run through the SDK that resolves here and through the tools over stdio; the `describe` cases through the SDK only, since a model has no approval screen to read. All 78 recorded cases, and each file's digest, equal the reference's.

## 0.6.0 — 2026-09-28

Link Home Assistant, or any home controller, to a hub from an agent: sign in on the device, create a connection of the `home_assistant` kind, and wait for the hub to admit it. Existing tool schemas are unchanged; every addition is optional.

- **Device sign-in as two tools.** `thalovant_begin_device_login` answers the code and URL to show a person with an opaque `loginId` (an empty `scopes` list is accepted and left out, so the API's default applies); `thalovant_poll_device_login` asks once and answers `pending` (with the interval, lengthened for good after a `slow_down`), `approved`, `expired` or `denied`. The device code and the minted token stay on the server, bound to the principal that began the sign-in, and never reach the model. With no credential configured, every control-plane tool for that principal then uses the token. `thalovant_revoke_device_login` signs out; a token already revoked counts as revoked, and signing out again answers `alreadyRevoked` without asking the API. A sign-in reaches only the configured API origin, because its verification URL is shown to a person.
- **Connections of a kind.** `thalovant_create_client_identity` takes `connectionType`; the API must answer with the same kind, and a connection it made without it is deleted again before the call fails. The result carries `clientId`, `connectionType` and `operationId`. A refusal adds guidance by kind after the API's own text: a kind the API does not know yet, a plan that does not allow it, a hub already linked (naming the connection that holds the link), or a token to sign in again.
- **Admission.** `thalovant_wait_for_admission` (read-only) follows the create's operation for the ninety seconds a hub takes and answers `admitted`; `failed`, with the operation's `errorCode` for a failure on the platform or the API's `status`, `code` and `detail` when it refused the wait itself; or `timeout` as an outcome to wait on again. A 429 is ridden out for the time the API names (its body, else `Retry-After`, else `RateLimit-Reset`), and one asking for longer than is left is a timeout at once. A token the API refuses and an API out of reach are tool errors of their own, each with a hint. It honours MCP cancellation and never follows a link to another origin than the API's.
- **`thalovant_delete_client`**, opt-in with the other destructive tools: `If-Match`, reading the etag first when none is given, one retry on `412`, and a connection already gone counts as deleted.
- The catalog has 50 default tools (24 in read-only mode, 53 with destructive tools enabled). `thalovant_config_status` reports `deviceLoginSignedIn`.
- Takes `@thalovant/sdk` ^0.9.0, which carries the device sign-in, the connection kinds and admission; the lock resolves 0.9.0.
- The parity contract declares `device-login`, `connection-kinds` and `connection-admission` as required and `home-link` as not applicable: a tool call holds a hub connection only for its own length, and nothing could answer a hub's request. The three vector files run through the SDK that resolves here, recorded before asserting, and through the tools over stdio, recorded under the same names; all 46 cases digest as the reference's (reference `2460eb90bd56`). Each worker of the recorder now writes only a shard of its own, and a Vitest global setup (`vitest.config.ts`) merges the shards once after every worker has finished: merging inside the workers let two of them stage the same file and rename each other's away, and a merge that scanned early could land after a complete one.
- The Dockerfile's version label had stayed at 0.4.0; it now says 0.6.0 like the rest.

## 0.5.3 — 2026-09-26

- A tool error says what the API said, not only the SDK's one-line message. That line is cut at 160 characters, and a `platform_image_required` refusal names every image each refused key may be instead -- longer than that -- so the list a model needed to retry was the part cut off, and `refused_images`, `allowed_images` and `allowed_repositories` never reached it at all. The error text now goes on with `code:`, `detail:` (the whole sentence, when the first line had to shorten it) and `fields:`, every other member of the body as compact, redacted JSON. A value a validation error echoes back from the request is redacted there and never reaches the first line.
- A `platform_image_required` or `plan_limit` 403 gets a hint that fits it instead of the general "Insufficient scopes" hint: granting a scope changes neither.
- The status behind a hint is read from the SDK error's `statusCode`, not parsed out of its message.
- Take `@thalovant/sdk` ^0.8.7, whose `ThalovantApiError` carries `code`, `detail` and `problem`. The shared `api-error-vectors.json` run here twice: through the SDK that resolves, recorded before it is asserted, and through a real tool call against the built server.
- New `api-errors` capability in the parity contract, declared `required`.

## 0.5.2 — 2026-09-19

- Take `@thalovant/sdk` ^0.8.2, which ends an ask the hub refuses at once as a typed refusal rather than waiting out its deadline and reporting that the hub did not answer in time. This server implements no part of an ask, so the behaviour arrives with the dependency -- and the shared refusal vectors now run here, against whatever version actually resolves, beside the conversation carry, the hive kinds and the binary frames.
- The parity contract's `refusal` capability moves from `planned` to `required`. It was the last capability holding the reference's release gate.

## 0.5.1 — 2026-09-13

- Expose advisory reply claim status and first-seen pipeline/skill identifiers, with shared conformance for fallback, mixed stages, legacy hubs and malformed stamps. Existing reply construction remains compatible.

## 0.5.0 — 2026-09-13

- Use Node SDK 0.7.0 inventory models and Python-compatible question detection.
- Add an inventory `presentation` view with derived skill titles, explicit phrase-language order, and unknown catalog metadata preserved.
- Gate PRs and publication on the shared SDK acceptance contract and check for drift every six hours.

## 0.4.1 — 2026-09-12

- Use Node SDK 0.6.1 with thalovant-languages 0.2.1 listing data, matching Python 0.6.8 across 270 languages.
- Verify Spanish questions and complete French phrases through the encrypted runtime inventory tool.

## 0.4.0 — 2026-09-12

- Add locale-aware sentence inventory examples with SDK 0.6.0, canonical slot defaults and unique rendered limits.
- Handle SIGTERM/SIGINT explicitly and close MCP sessions and HTTP connections when running as PID 1.
- Align the Dockerfile version label with the package and registry metadata.

## 0.3.0 — 2026-09-12

- Use Node SDK 0.5.0 request hints, bounded embedded audio replies, and speakable intent examples. Keep embedded audio out of model text; offer explicit audio/resource content blocks through includeAudio.
- Default runtime configuration tools to revision-guarded merging with at most three attempts and only HTTP 412 retries. Preserve explicit replacement with merge: false. Guarded merging requires hubs:read and paid hubs:write.
- Cover actual encrypted runtime hints/audio and default conditional-write conflict handling through MCP tool calls. Preserve the existing tool catalog and align npm/OCI/registry versions.

## 0.2.0 — 2026-09-12

- Add a read-only hub skill history tool using Node SDK 0.4.0. The catalog now has 46 default tools, 23 in read-only mode, and 48 with destructive tools enabled.
- Correct shared-runtime skill scope and token requirements.

## 0.1.24

- Require Node SDK 0.3.16 and use its public hub-skill methods instead of the temporary duplicate HTTP and polling implementation. Preserve tool schemas, accepted-operation output, API guidance and MCP cancellation checks.
- Stop starting status reads once the polling budget expires. Keep the accepted operation ID visible when polling fails or the operation reports failure, so callers can inspect the existing operation without repeating the write. The polling deadline does not cancel an HTTP request already in flight.
- Add real stdio regressions for failed status reads, deadline boundaries and cancellation; retain the 45-tool default catalog across stdio and Streamable HTTP.

## 0.1.23

- Add hub-scoped skill management: `thalovant_list_hub_skills` (read-only, `hubs:inspect`), `thalovant_install_hub_skill`, `thalovant_update_hub_skill` and `thalovant_remove_hub_skill` (`hubs:write`, paid plan) act on one hub rather than a runtime group's skill set; changes apply live on the hub in about 15 seconds. The list tool returns the whole `GET /v1/hubs/{hub_id}/skills` envelope (`hub_id`, `runtime_group_id`, `observed_at`, `source`, the runtime's phase and message, and `data` rows with a `pending|installed|failed|removing|drifted|quarantined|unmanaged` state). Writes answer with the accepted operation (`operation_id`, `hub_id`, `runtime_group_id`, `skill`, `version`, `previous_version`, `state`) and take `wait` to poll it every 2 s until it converges (`installed`/`removed`, or an error carrying the operation's `error_message`), honoring MCP request cancellation and a 120 s default `timeoutMs`. Installing an already-installed skill at another version performs an update.
- Surface the API's RFC 7807 problem codes: the tool error keeps the short message and appends the root `code`, e.g. `HTTP 409: Skill version already installed. (skill_version_already_installed)`, and the guidance explains `409 skill_version_already_installed`, `404 hub_without_runtime_group`, and a `422` for an unresolvable `latest` or invalid version on install.
- Call `GET/POST /v1/hubs/{hub_id}/skills` and `PATCH/DELETE /v1/hubs/{hub_id}/skills/{skill}` directly, with the SDK's header, HTTPS-or-loopback and redirect conventions, and poll with the SDK's `getOperation`, until the Node SDK ships these methods (`@thalovant/sdk` >= 0.3.15). Every route and response type (the final contract of thalovant-api #253) lives in one marked block in `src/index.ts`.
- The default catalogue now contains 45 tools (22 in read-only mode, 47 with destructive tools enabled). Existing tool schemas are unchanged.

## 0.1.22

- Require Node SDK 0.3.14 for fail-closed persistent Noise trust, complete filesystem state transactions across Node processes, active reply-ID guards, and intent-description timeouts that only recover when usable definitions were received. Preserve process-local runtime identity leases and require distinct identities across independently running MCP processes.
- Correct global-deny precedence, process restart guidance, and historical unmatched-intent/redaction release notes.
- Validate successful provisioning results and protected identity-file creation, including nonempty credentials, matching persisted values, redacted output and private permissions. Share the fake control-plane server and handle malformed test requests safely.
- Require Node 22.22.2 or newer within the 22.x line for the pinned npm 12 publisher.

## 0.1.21

- Propagate MCP request cancellation through runtime identity acquisition and SDK connection, Ask, Query and event waits in stdio and Streamable HTTP mode. Require Node SDK 0.3.12 for Query cancellation and explicit HTTP admission cleanup failures, including contradictory disconnect acknowledgments.
- Skip cancelled queued calls without constructing a client or interrupting the active identity owner. Retain admitted work and actual cleanup after caller cancellation, including SDK operations without cancellation support; preserve failed-cleanup poisoning and never replay application writes.
- Check cancellation during connection setup before action/code sends, raw event publication and inventory discovery. Tool schemas and the 41-tool default catalogue remain compatible.
- Verify actual MCP cancellation against independent HTTPS Noise peers on both MCP transports, with late queued execution, pending physical write and healthy successor regressions. Add real remote-cleanup refusal cases that prove an identity with unconfirmed HTTP cleanup remains unavailable instead of admitting an overlapping client.

## 0.1.20

- Require HTTPS for credential-bearing API calls, preserving explicit loopback HTTP for local development. Reject API redirects through the SDK. Instantiate runtime clients only after acquiring their identity lease.
- Bind server-managed Thalovant tokens and password login to their configured API origin. Reject cross-origin tool overrides before any outbound request, including credentials for remote principals; retain configured custom origins and anonymous public discovery.
- Add `thalovant_query` for routed HiveMind queries, preserving query/request/session correlation and runtime identity cleanup; hide it in read-only mode. The default catalogue now contains 41 tools.
- Add read-only `thalovant_intent_inventory` and `thalovant_get_operation` tools for runtime discovery and asynchronous provisioning status. Inventory preserves fallback knowledge and conservative answerability.
- Require Node SDK 0.3.9 for aligned intent discovery, request correlation, whole-operation reply deadlines, fixed Ask settlement windows, cancellation and retained cleanup ownership, and credential-safe control-plane redirect handling.
- Retain the runtime identity lease until actual cleanup, even after a caller close timeout; failed cleanup blocks later identity reuse with an explicit error. Bound queued lease acquisition to six seconds without releasing pending ownership or executing expired callers.
- Upgrade the test runner to Vitest 4.1.11 to remove GHSA-82fw-gwwq-j7x9.
- Test Node 20, 22 and 24; add per-principal/shared credential regressions and exercise the inventory tool over a real HTTPS Noise session.

## 0.1.19

- Require Node SDK 0.3.5 or newer so runtime tools receive secure MQTT URL enforcement and bounded MQTT setup and HTTP failure cleanup.
- Keep package, registry, and container source metadata on version 0.1.19. Runtime tool names, inputs, and identity serialization remain compatible.

## 0.1.18

- Serialize runtime tool calls sharing a hub client identity so concurrent calls cannot replace each other's Noise sessions or HTTP message queues. Different identities remain independent.
- Use Node SDK 0.3.4 or newer for authenticated HiveMind v3 Noise across WSS, HTTPS and MQTT. HTTPS retains replica affinity and uses binary encrypted polling; MQTT reauthenticates when reconnecting.
- Derive the advertised MCP server version from the package manifest so stdio, Streamable HTTP, npm, OCI and registry metadata agree. Add transport smoke assertions for version consistency.

## Historical updates before 0.1.18

### Fixed

- The server talks to HiveMind 5.x hubs. `@thalovant/sdk` 0.3.x speaks the protocol v3 Noise transport (the published 0.1.16 bundled 0.2.37 and could not connect to a 5.x hub at all); 0.3.3 additionally derives the v3 pre-shared key with WebAssembly argon2id and caches the derived key (only the key, never a password fingerprint) beside the client identity, so a reconnect skips the ~3 s derivation. Bumped the dependency floor to `^0.3.3` and refreshed the lockfile so the npm package and OCI image both ship it (thalovant-mcp#50).
- `thalovant_ask` picks up the reply-correlation fixes from `@thalovant/sdk` 0.2.37: a hub-rewritten session id no longer rejects replies, and replies are correlated by request id rather than the session id a hub replaces. Bumped the dependency floor to `^0.2.37` and refreshed the lockfile so the npm package and OCI image both ship them.
- Earlier unmatched-intent fixes progressed from query-path recognition in `@thalovant/sdk` 0.2.33 to bus-path event collection in 0.2.34, then recoverable soft-miss settlement in 0.2.35. The earlier event-only changes did not by themselves finish a silent bus Ask promptly. Later releases above supersede these dependency floors and preserve fallback replies within the documented fixed wait.

### Security

- `thalovant_install_runtime_group_skill` now refuses non-catalog install sources by default. A `sourceType` other than `catalog` (notably `git` with an arbitrary `sourceRef`) can pull unvetted code into a production runtime, and the control-plane validator is format-only with no host allowlist, so it is rejected before any control-plane request unless the operator sets `THALOVANT_ENABLE_GIT_SKILL_SOURCES` (accepting `1`/`true`/`yes`/`on`), mirroring the `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS` gate. `sourceType` is trimmed and case-folded before it is both checked and forwarded, so a variant such as `" Catalog "` or `"CATALOG"` cannot pass the local gate yet reach the control plane — which special-cases only the exact string `"catalog"` — as an unrecognized non-catalog source. The tool is now annotated `destructiveHint: true`, and `thalovant_config_status` reports `gitSkillSourcesEnabled`.
- `thalovant_create_client_identity` now confines the optional `savePath` to a configurable identity directory (`THALOVANT_MCP_IDENTITY_DIR`, default `<config-dir>/thalovant/identities`). Absolute paths outside the directory and `..` traversal are rejected, and the destination is validated before the identity is created in the control plane, so a model can no longer drop a `0600` credential file into a git working tree or synced folder. `thalovant_config_status` reports `identityDir`.
- `thalovant_healthcheck` output is now passed through `redactSecrets`, matching every other tool output.
- `thalovant_get_analytics_overview` no longer advertises the `admin` and (admin-only) `ownerId` arguments to the model, so it no longer teaches an admin mode that only ever 403s for non-admin callers; only the plain overview call remains. Injected `admin`/`ownerId` values are stripped and never reach the control plane.
- Extended output redaction to additional secret-ish keys: `device_code`, `deviceCode`, `user_code`, `userCode`, `authToken`, `authorization`, `bearer`, `psk`, `cert`, and `jwt`.
- Added an opt-in read-only mode (`THALOVANT_MCP_READONLY`): only tools annotated `readOnlyHint: true` are registered, so an observe-only agent needs no hand-written denylist. `thalovant_config_status` reports `readOnly`.

## 0.1.10

- Added hub-provisioning and skill-discovery tools so an agent can discover skills and provision hubs conversationally, all delegating to `@thalovant/sdk` (now `^0.2.28`).
- Discovery tools: `thalovant_list_marketplace_skills`, `thalovant_list_runtime_group_marketplace`, `thalovant_list_runtime_group_inventory`, `thalovant_list_runtime_groups`, `thalovant_get_runtime_group`, `thalovant_get_runtime_group_config`, `thalovant_get_hub_runtime_capabilities`.
- Provisioning tools: `thalovant_create_hub`, `thalovant_update_hub`, `thalovant_release_hub`, `thalovant_set_hub_rating`, `thalovant_clear_hub_rating`, `thalovant_create_runtime_group`, `thalovant_update_runtime_group`, `thalovant_update_runtime_group_config`, `thalovant_release_runtime_group`, `thalovant_install_runtime_group_skill`, `thalovant_uninstall_runtime_group_skill`.
- `thalovant_delete_hub` and `thalovant_delete_runtime_group` are **disabled by default**: they are not registered at all unless the operator sets `THALOVANT_ENABLE_DESTRUCTIVE_TOOLS`, so they never appear in `tools/list`. The existing allow/deny tool policy is a call-time filter that cannot express a default-off tool, so this is a separate registration-time gate; once enabled, the delete tools remain subject to that policy. `thalovant_config_status` now reports `destructiveToolsEnabled`.
- Mirrored the control-plane API's exact constraints in the new input schemas so invalid values fail client-side instead of as an opaque 422: hub `spec.version` required, `name` max 128, `slug` 1-191 matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`, `namespace` max 128, `domain` max 255, `visibility` max 32, `capacity_profile` restricted to `standard`/`autoscaling`, hub rating 1-5, runtime group `name` max 128 and `description` max 255, runtime group `spec.replicas` 1-20, skill `skill_id` max 191, `source_ref` max 255, `version_pin` max 64, and `marketplace_skill_id` a UUID. `source_type` is intentionally left a free-form 1-32 string because the API does not constrain it to an enum.
- `thalovant_update_hub` requires an `etag` and no longer accepts `name`, `namespace`, or `domain`, which are immutable after creation; the description directs agents to read the etag from the hub resource body, since the API sends no `ETag` response header. `thalovant_delete_hub` requires an `etag` for the same reason.
- Control-plane failures on the new tools now carry actionable guidance that distinguishes `403 Insufficient scopes` (checked before the plan gate, so it can mask a plan problem), the `402 API access requires a paid plan.` gate, the distinct `402 This skill requires paid marketplace access for the tenant plan.` at skill install, `412 ETag mismatch`, and `409` idempotency-key reuse.
- Documented the scope map for the new surface — `hubs:read` for the catalog, `hubs:inspect` for runtime-group and hub runtime views, `hubs:write` plus a paid plan for provisioning — and noted that catalog browsing is not paid-gated, so a free-tier token can browse the marketplace but cannot install.

## 0.1.9

- Added first-class scoped API token auth for the control plane: set `THALOVANT_API_TOKEN` and the server authenticates with the token directly and never calls the login endpoint. Precedence is `THALOVANT_API_TOKEN`, then `THALOVANT_ACCESS_TOKEN`, then the `THALOVANT_EMAIL`/`THALOVANT_PASSWORD` login fallback.
- `thalovant_config_status` now reports the active control-plane auth mode (`controlPlaneAuthMode`: `api-token`, `access-token`, `email-password`, or `none`) and `hasApiToken`, without revealing token values.
- Documented API tokens as the recommended auth mode for AI and CI use, including the minimum token scopes for the full control-plane tool surface: `hubs:read`, `clients:write`, `memory:read`, `memory:write`.
- Clarified the unauthenticated-tool error to name `THALOVANT_API_TOKEN` as the recommended option.

## 0.1.8

- Tightened memory tool input validation to match the control-plane API exactly: `title` max 160, `content` max 4096, `source` max 64, `consentScope` max 128, `consentVersion` max 64, `retentionPolicy` max 64 on create/update, and list `query` max 240, so invalid values fail with a clear client-side error instead of an opaque API 422.
- Capped `thalovant_list_public_hubs` `limit` at 48 to match the public hubs endpoint, which silently clamps larger page sizes; authenticated `thalovant_list_hubs` keeps its limit of 100.
- Corrected `thalovant_get_hub` and `thalovant_create_client_identity` descriptions: the authenticated hub routes require a hub UUID; slugs are only accepted by the public hub tools.

## 0.1.7

- Updated the MCP transport SDK to 1.30.0, removing the affected Hono adapter dependency range.
- Updated the Thalovant Node SDK compatibility floor to 0.2.21 and refreshed the JOSE runtime dependency.
- Included the dependency and transitive security updates merged after 0.1.6.

## 0.1.6

- Publish the exact npm tarball with a durable CycloneDX SBOM and GitHub provenance and SBOM attestations.
- Publish the OCI image with SBOM and maximum provenance and verify the pinned MCP Registry publisher before execution.

## 0.1.5

- Added the public GHCR OCI package to MCP Registry metadata.
- Switched deployment image references to the repo-aligned GHCR package.

## 0.1.4

- Fixed npm bin execution when the package manager launches the server through a symlink.
- Added a symlink-based stdio smoke test for published package behavior.

## 0.1.3

- Removed the generic remote URL from registry metadata; publish concrete remote entries only after a real hosted URL exists.

## 0.1.2

- Updated the server runtime version constant.
- Published MCP Registry metadata with the public npm package only; GHCR remains available but must be made public in GitHub package settings before registry inclusion.

## 0.1.1

- Normalized npm bin metadata.
- Added OCI package transport URL for MCP Registry validation.
- Updated container tags and metadata to match the registry release.

## 0.1.0

- Initial public MCP server for Thalovant.
- Added stdio transport for local MCP hosts.
- Added Streamable HTTP transport for remote MCP clients.
- Added static bearer, JWT/JWKS, and OAuth introspection auth modes.
- Added protected resource metadata discovery.
- Added per-principal Thalovant credential isolation.
- Added tool allow/deny policy.
- Added structured audit logging.
- Added in-memory and file-backed event storage.
- Added Docker, Compose, Kubernetes, CI, registry metadata, smoke tests, and benchmarks.
