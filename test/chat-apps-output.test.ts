/**
 * The chat app presentation (src/chat-apps-output.ts) on its own: the status
 * in plain words, the views a model reads, and the hint after each refusal.
 * The tools that use it are exercised over stdio in chat-apps.test.ts.
 */
import { ThalovantApiError, ThalovantApiUnreachableError, ThalovantPlanError } from "@thalovant/sdk";
import type { Bridge, ChatAppConnector } from "@thalovant/sdk";
import { describe, expect, it } from "vitest";

import {
  bridgeErrorHint,
  bridgeStatusSummary,
  bridgeView,
  chatsOutput,
  connectorsOutput,
  networksOutput,
  secretLookingSettings,
  secretSettingsRefusal,
} from "../src/chat-apps-output.js";

/** Stands in for the server's key-name redaction. */
const redact = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, nested) => (/token|secret|password/i.test(key) ? "[redacted]" : nested)));

function bridge(overrides: Partial<Bridge> = {}, status: Partial<Bridge["status"]> = {}): Bridge {
  return {
    id: "6f1c8a1e-3b2d-4c5e-8f9a-0b1c2d3e4f50",
    hub_id: "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d",
    owner_id: "8b3c4d5e-6f7a-4b2c-8d3e-4f5a6b7c8d9e",
    network: "telegram",
    connector: { id: "telegram", name: "Telegram", version: "1.4.0" },
    settings: {},
    secrets_set: ["token"],
    state: "active",
    resource_name: "bridge-6f1c8a1e",
    bot: { user_id: "1234", username: "KitchenHubBot", display_name: "Kitchen", application_id: null, avatar_url: "https://api.example/v1/bridges/x/avatar" },
    invite_links: { add_to_group: "https://t.me/KitchenHubBot?startgroup=thalovant", direct_chat: "https://t.me/KitchenHubBot" },
    allowed: [{ id: "-1001", title: "Family", kind: "supergroup", guild_id: null, guild_name: null }],
    require_mention: true,
    session_scope: "person",
    paused: false,
    hold: null,
    etag: "etag-1",
    token_updated_at: "2026-11-01T10:00:00Z",
    activated_at: "2026-11-01T10:05:00Z",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-02T10:00:00Z",
    operation: null,
    ...overrides,
    status: {
      phase: "Ready",
      ready: true,
      reason: "Connected",
      message: null,
      operator_reason: null,
      generation: 3,
      observed_generation: 3,
      applied: true,
      source: "operator",
      ...status,
    },
  };
}

describe("bridge status in plain words", () => {
  it.each([
    ["Setup", "Setup", /no chats are chosen yet/],
    ["Starting", "Pending", /on its way or has not reported yet/],
    ["Connected", "Ready", /running and answers in its allowed chats/],
    ["Unavailable", "Degraded", /deployed but not running/],
    ["TokenMissing", "Pending", /token has not reached it.*Replace token/],
    ["TokenRejected", "Error", /refused the bridge's credentials.*Replace token.*never takes a token/],
  ])("words %s", (reason, phase, words) => {
    expect(bridgeStatusSummary(bridge({}, { reason, phase, applied: null }))).toMatch(words);
  });

  it("says the owner paused it, and how to resume", () => {
    const summary = bridgeStatusSummary(bridge({ paused: true }, { reason: "Paused", phase: "Paused" }));
    expect(summary).toMatch(/Paused by its owner/);
    expect(summary).toContain("thalovant_resume_bridge");
  });

  it("names a plan hold and when it started", () => {
    const summary = bridgeStatusSummary(bridge(
      { paused: true, hold: { reason: "plan_limit", since: "2026-11-02T08:00:00Z" } },
      { reason: "Paused", phase: "Paused" },
    ));
    expect(summary).not.toMatch(/by its owner/);
    expect(summary).toMatch(/2026-11-02T08:00:00Z because the plan allows fewer running chat apps/);
    expect(summary).toContain("thalovant_get_bridge_networks");
  });

  it("names a suspension hold", () => {
    const summary = bridgeStatusSummary(bridge(
      { paused: true, hold: { reason: "account_suspended", since: "2026-11-02T08:00:00Z" } },
      { reason: "Paused", phase: "Paused" },
    ));
    expect(summary).toMatch(/account was deactivated; it resumes when the account is reactivated/);
  });

  it("says whether changes are applied", () => {
    expect(bridgeStatusSummary(bridge({}, { applied: true }))).toMatch(/Every change is applied\.$/);
    expect(bridgeStatusSummary(bridge({}, { applied: false }))).toMatch(/A change is still on its way to the bridge\.$/);
    expect(bridgeStatusSummary(bridge({}, { applied: null }))).not.toMatch(/applied|on its way to the bridge/);
  });

  it("says a pause or a resume is still on its way", () => {
    expect(bridgeStatusSummary(bridge({ paused: true }, { reason: "Connected", applied: false }))).toMatch(/stopping it may still be on its way/);
    expect(bridgeStatusSummary(bridge({ paused: false }, { reason: "Paused", applied: false }))).toMatch(/starting again may still be on its way/);
    expect(bridgeStatusSummary(bridge({ paused: true, state: "setup" }, { reason: "Setup", phase: "Setup", applied: null }))).toMatch(/choosing chats will not start it/);
  });

  it("keeps a reason or hold this server does not know", () => {
    expect(bridgeStatusSummary(bridge({}, { reason: "Throttled", phase: "Degraded", applied: null }))).toBe(
      "Throttled: a status this server does not know yet (phase Degraded).",
    );
    expect(bridgeStatusSummary(bridge({ paused: true, hold: { reason: "maintenance", since: "2026-11-02" } }, { reason: "Paused" }))).toMatch(/\(maintenance\)/);
  });
});

describe("bridge view", () => {
  it("leaves out the platform-only status fields and keeps the API's members by name", () => {
    const view = bridgeView(bridge({}, { message: "platform-diagnostic", operator_reason: "PlatformCondition" }), redact);
    const text = JSON.stringify(view);
    expect(text).not.toContain("platform-diagnostic");
    expect(text).not.toContain("PlatformCondition");
    expect(view.status).toEqual({ reason: "Connected", phase: "Ready", ready: true, applied: true, summary: expect.stringMatching(/^Connected/) });
    // Names and a time, which key-name redaction would have hidden.
    expect(view.secrets_set).toEqual(["token"]);
    expect(view.token_updated_at).toBe("2026-11-01T10:00:00Z");
    expect(view).not.toHaveProperty("resource_name");
  });

  it("redacts the owner's free-form settings and a queued operation", () => {
    const view = bridgeView(bridge({
      settings: { homeserver: "https://matrix.example.org", access_token: "syt_should-not-appear" },
      operation: { id: "op-1", status: "requested", refresh_token: "rt-should-not-appear" } as unknown as Bridge["operation"],
    }), redact);
    expect(JSON.stringify(view)).not.toMatch(/should-not-appear/);
    expect(view.settings).toEqual({ homeserver: "https://matrix.example.org", access_token: "[redacted]" });
    expect(view.operation).toMatchObject({ id: "op-1", status: "requested" });
  });
});

describe("connector, allowance and chat views", () => {
  const matrix: ChatAppConnector = {
    id: "matrix",
    name: "Matrix",
    mark: "matrix",
    status: "beta",
    description: { en: "Answer in Matrix rooms.", fr: "Répondre dans les salons Matrix." },
    setup_steps: { en: "Invite the bot.", fr: null },
    config_schema: {
      type: "object",
      required: ["homeserver"],
      properties: {
        homeserver: { type: "string", format: "uri", title: "Homeserver", "x-title-fr": "Serveur d'accueil" },
        user_id: { type: "string", title: "Bot user id" },
      },
    },
    secrets: [{ key: "access_token", label: { en: "Access token", fr: "Jeton d'accès" }, description: null, required: true }],
    targets: { label: { en: "Rooms", fr: "Salons" }, pattern: "^!.+$", max: 50, lowercase: false, strip_prefix: null },
    options: { require_mention_fixed: false, session_scopes: ["person", "chat"] },
    helpers: [],
    offered: false,
    version: null,
  };

  it("words a connector in French, falling back to English, with secrets by name only", () => {
    const output = connectorsOutput([matrix], "fr", redact);
    const [view] = output.data as Array<Record<string, any>>;
    expect(view.description).toBe("Répondre dans les salons Matrix.");
    expect(view.setup_steps).toBe("Invite the bot.");
    expect(view.secrets).toEqual([{ key: "access_token", label: "Jeton d'accès", description: null, required: true }]);
    expect(view.settings).toEqual([
      { key: "homeserver", title: "Serveur d'accueil", required: true, type: "string", format: "uri" },
      { key: "user_id", title: "Bot user id", required: false, type: "string" },
    ]);
    expect(view.targets).toEqual({ label: "Salons", pattern: "^!.+$", max: 50, lowercase: false, strip_prefix: null });
    expect(view).not.toHaveProperty("mark");
    expect(output.next).toMatch(/console.*never takes a token or secret/);
  });

  it("says a Free plan gets no chat apps, and words a paid allowance", () => {
    const free = networksOutput({
      networks: [{ network: "telegram", offered: true, name: "Telegram", mark: "telegram", status: "offered" }],
      allowance: { owner_id: "o", plan: "Free", paid_plan: false, limit: 0, used: 0, remaining: 0, can_create: false },
    }, redact);
    expect(free.summary).toMatch(/Free plans get 0/);
    expect(free.networks).toEqual([{ network: "telegram", name: "Telegram", status: "offered", offered: true }]);
    const home = networksOutput({
      networks: [],
      allowance: { owner_id: "o", plan: "Home", paid_plan: true, limit: 2, used: 1, remaining: 1, can_create: true },
    }, redact);
    expect(home.summary).toMatch(/^The Home plan: 1 of 2 chat apps used \(set up or running\), 1 left\. A new one would pass the plan checks/);
    const full = networksOutput({
      networks: [],
      allowance: { owner_id: "o", plan: "Home", paid_plan: true, limit: 2, used: 2, remaining: 0, can_create: false },
    }, redact);
    expect(full.summary).toMatch(/would not pass the plan checks now/);
  });

  it("tells a model to type ids when a chat app cannot list them", () => {
    expect(chatsOutput({ network: "matrix", data: [], note: null, manual_entry: true }, redact).next).toMatch(/type each id yourself/);
    const listed = chatsOutput({
      network: "discord",
      data: [{ id: "42", title: "general", kind: "text", guild_id: "7", guild_name: "Home", guild_icon_url: null, allowed: true, encrypted: false, selectable: true }],
      note: null,
      manual_entry: false,
    }, redact);
    expect(listed.data).toEqual([{ id: "42", title: "general", kind: "text", guild_id: "7", guild_name: "Home", guild_icon_url: null, allowed: true, encrypted: false, selectable: true }]);
    expect(listed.next).toMatch(/replaces the whole list/);
  });
});

describe("settings that look like secrets", () => {
  const isSecret = (key: string) => /token|secret|password/i.test(key);

  it("names them without their values", () => {
    expect(secretLookingSettings({ homeserver: "https://x", access_token: "syt_value" }, isSecret)).toEqual(["access_token"]);
    expect(secretLookingSettings(undefined, isSecret)).toEqual([]);
    const refusal = secretSettingsRefusal(["access_token"]);
    expect(refusal).toMatch(/^Nothing was sent: .*setting names look like one: access_token\./);
    expect(refusal).not.toContain("syt_value");
  });

  it("finds them at any depth, as dotted paths, and returns no value", () => {
    const settings = {
      homeserver: "https://x",
      server: { url: "https://y", auth: { bot_token: "nested-value", user: "hub" } },
      hosts: [{ name: "a" }, { client_secret: "array-value" }],
      plain: ["token-looking-value-is-not-a-name"],
    };
    const found = secretLookingSettings(settings, isSecret);
    expect(found).toEqual(["server.auth.bot_token", "hosts.1.client_secret"]);
    expect(JSON.stringify(found)).not.toMatch(/nested-value|array-value/);
  });
});

describe("hints after a refused chat app call", () => {
  function refusal(status: number, problem: Record<string, unknown>, retryAfterSeconds?: number): ThalovantApiError {
    return new ThalovantApiError(`HTTP ${status}`, { statusCode: status, problem, retryAfterSeconds });
  }

  it("names the settings a refusal is about, read at the top or inside detail", () => {
    const top = bridgeErrorHint(refusal(422, { code: "bridge_settings_invalid", detail: "Unknown setting.", fields: ["homeserver", "bot_login"] }));
    expect(top).toMatch(/The API named the settings: homeserver, bot_login \(values are never repeated\)/);
    const nested = bridgeErrorHint(refusal(422, { detail: { code: "bridge_url_not_public", detail: "Not public.", fields: ["homeserver"] } }));
    expect(nested).toMatch(/https on port 443/);
    expect(nested).toMatch(/named the settings: homeserver/);
  });

  it.each([
    ["bridge_running", 409, /pause it with thalovant_pause_bridge/i],
    ["bridge_telegram_updates_busy", 409, /another program or a webhook/],
    ["bridge_helper_unavailable", 409, /no test message/],
    ["bridge_token_missing", 409, /only the Thalovant console.*takes/],
    ["bridge_token_invalid", 422, /never takes a token or secret/],
    ["bridge_network_refused", 422, /bot was removed from that chat/],
    ["bridge_allowed_required", 422, /pause it with thalovant_pause_bridge/],
    ["bridge_chat_id_invalid", 422, /targets\.pattern/],
    ["bridge_chat_not_allowed", 422, /allowed list/],
    ["bridge_too_many_targets", 422, /targets\.max/],
    ["bridge_mention_required", 422, /Discord bridge answers only messages that mention it/],
    ["bridge_network_unavailable", 502, /could not be reached/],
    ["bridge_network_timeout", 504, /did not answer in time/],
    ["bridge_network_not_offered", 503, /thalovant_get_bridge_networks/],
    ["bridge_secret_store_unavailable", 503, /store that keeps bridge tokens/],
  ])("explains %s", (code, status, hint) => {
    expect(bridgeErrorHint(refusal(status, { code, detail: "refused" }))).toMatch(hint);
  });

  it("says how long to wait after a rate limit", () => {
    expect(bridgeErrorHint(refusal(429, { code: "bridge_rate_limited", detail: "Slow down." }, 120))).toMatch(/Wait 120 seconds/);
    expect(bridgeErrorHint(refusal(429, { code: "bridge_network_rate_limited", detail: "Slow down." }))).toMatch(/limiting this bot\. Wait before/);
  });

  it("explains the plan refusals", () => {
    const limit = new ThalovantPlanError("HTTP 403", { statusCode: 403, problem: { code: "plan_limit", resource: "chat_bridge", limit: 2, used: 2 } });
    expect(bridgeErrorHint(limit)).toMatch(/chat-app allowance is used/);
    expect(bridgeErrorHint(new ThalovantPlanError("HTTP 402", { statusCode: 402, problem: { detail: "API access requires a paid plan." } }))).toMatch(/Free plans get 0/);
  });

  it.each([
    [401, /Sign in again/],
    [403, /hubs:read scope, and changing them hubs:write\. Listing a bridge's chats \(thalovant_list_bridge_chats\) also needs hubs:write and a paid plan/],
    [404, /No bridge with this id is visible/],
    [412, /ETag mismatch.*thalovant_get_bridge/],
  ])("explains a bare HTTP %i", (status, hint) => {
    expect(bridgeErrorHint(refusal(status, { detail: "refused" }))).toMatch(hint);
  });

  it("warns that an unreachable API says nothing about the bridge, and leaves other errors alone", () => {
    expect(bridgeErrorHint(new ThalovantApiUnreachableError("unreachable"))).toMatch(/Read the bridge with thalovant_get_bridge/);
    expect(bridgeErrorHint(new Error("local"))).toBeUndefined();
    expect(bridgeErrorHint(refusal(500, { detail: "boom" }))).toBeUndefined();
  });
});
