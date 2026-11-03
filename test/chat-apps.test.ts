/**
 * The chat app tools over stdio, against the built server and a loopback API:
 * what each one asks the API for, what a model reads back (the status in
 * plain words, never the platform's own message or a credential), what each
 * refusal adds, and which tools exist in each mode.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const API_TOKEN = "tvpat_chat-apps-test-token";
const BRIDGE_ID = "6f1c8a1e-3b2d-4c5e-8f9a-0b1c2d3e4f50";
const HUB_ID = "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
const OWNER_ID = "8b3c4d5e-6f7a-4b2c-8d3e-4f5a6b7c8d9e";
const BRIDGE_PATH = `/v1/bridges/${BRIDGE_ID}`;

const READ_TOOLS = [
  "thalovant_list_chat_app_connectors",
  "thalovant_get_bridge_networks",
  "thalovant_list_bridges",
  "thalovant_get_bridge",
  "thalovant_list_bridge_chats",
];
const WRITE_TOOLS = [
  "thalovant_pause_bridge",
  "thalovant_resume_bridge",
  "thalovant_update_bridge",
  "thalovant_send_bridge_test_message",
];

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

interface FakeResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface FakeControlPlane {
  url: string;
  requests: RecordedRequest[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A loopback API answering each request with what `respond` returns (404 when it returns nothing). */
async function startFakeControlPlane(respond: (request: RecordedRequest) => FakeResponse | undefined): Promise<FakeControlPlane> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const request: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value ?? "")]),
        ),
        body: raw.trim() ? JSON.parse(raw) as Record<string, unknown> : undefined,
      };
      requests.push(request);
      const answer = respond(request) ?? { status: 404, body: { detail: "Not Found" } };
      if (answer.status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(answer.status ?? 200, { "Content-Type": "application/json", ...answer.headers });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  }));
  return { url: `http://127.0.0.1:${port}`, requests };
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("THALOVANT_") || key.startsWith("MCP_")) continue;
    env[key] = value;
  }
  return env;
}

async function connectStdioClient(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...baseEnv(), ...env } });
  const client = new Client({ name: "thalovant-mcp-chat-apps", version: "0.0.0" }, { capabilities: {} });
  cleanups.push(() => client.close());
  await client.connect(transport);
  return client;
}

async function connectToApi(fake: FakeControlPlane, env: Record<string, string> = {}): Promise<Client> {
  return connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url, ...env });
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError ?? false, resultText(result)).toBe(false);
  return JSON.parse(resultText(result));
}

async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, resultText(result)).toBe(true);
  return resultText(result);
}

function only(fake: FakeControlPlane, method: string, path: string): RecordedRequest {
  const matching = fake.requests.filter((request) => request.method === method && request.path === path);
  expect(matching, fake.requests.map((request) => `${request.method} ${request.path}`).join(", ")).toHaveLength(1);
  return matching[0];
}

/** A bridge as the API sends it; an administrator's token also gets the platform's own message. */
function wireBridge(overrides: Record<string, unknown> = {}, status: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BRIDGE_ID,
    hub_id: HUB_ID,
    owner_id: OWNER_ID,
    network: "telegram",
    connector: { id: "telegram", name: "Telegram", version: "1.4.0" },
    settings: {},
    secrets_set: ["token"],
    state: "active",
    resource_name: `bridge-${BRIDGE_ID}`,
    bot: { user_id: "5550001", username: "KitchenHubBot", display_name: "Kitchen", application_id: null, avatar_url: `https://api.example${BRIDGE_PATH}/avatar` },
    invite_links: { add_to_group: "https://t.me/KitchenHubBot?startgroup=thalovant", direct_chat: "https://t.me/KitchenHubBot" },
    allowed: [{ id: "-1001", title: "Family", kind: "supergroup" }],
    require_mention: true,
    session_scope: "person",
    paused: false,
    hold: null,
    etag: "etag-7",
    token_updated_at: "2026-11-01T10:00:00Z",
    activated_at: "2026-11-01T10:05:00Z",
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-02T10:00:00Z",
    ...overrides,
    status: {
      phase: "Ready",
      ready: true,
      reason: "Connected",
      message: "platform-diagnostic-ready",
      operator_reason: "PlatformConditionReady",
      generation: 4,
      observed_generation: 4,
      applied: true,
      source: "operator",
      ...status,
    },
  };
}

/** A Problem+JSON refusal the way the API's bridge routes send it: FastAPI's envelope around the code. */
function refusal(status: number, code: string | undefined, detail: string, extra: Record<string, unknown> = {}): FakeResponse {
  return { status, body: { detail: code ? { detail, code, ...extra } : detail } };
}

describe("chat app tool registration", () => {
  it("lists the chat app tools by default, the delete tool only when destructive tools are on, and annotates each", async () => {
    const byDefault = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });
    const tools = (await byDefault.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) expect(names).toContain(name);
    expect(names).not.toContain("thalovant_delete_bridge");
    for (const name of READ_TOOLS) {
      expect(tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({ readOnlyHint: true });
    }
    for (const name of WRITE_TOOLS) {
      expect(tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }

    const destructive = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "true" });
    const remove = (await destructive.listTools()).tools.find((tool) => tool.name === "thalovant_delete_bridge");
    expect(remove?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const status = JSON.parse(resultText(await destructive.callTool({ name: "thalovant_config_status", arguments: {} })));
    expect(status.destructiveTools).toContain("thalovant_delete_bridge");
  }, 20_000);

  it("keeps only the chat app reads in read-only mode", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_MCP_READONLY: "1", THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "1" });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of READ_TOOLS) expect(names).toContain(name);
    for (const name of [...WRITE_TOOLS, "thalovant_delete_bridge"]) expect(names).not.toContain(name);
  }, 15_000);

  it("takes no token or secret in any chat app tool, and says where they go", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "1" });
    const tools = (await client.listTools()).tools.filter((tool) => /bridge|chat_app/.test(tool.name));
    expect(tools).toHaveLength(READ_TOOLS.length + WRITE_TOOLS.length + 1);
    for (const tool of tools) {
      for (const property of Object.keys(tool.inputSchema.properties ?? {})) {
        expect(property, `${tool.name}.${property}`).not.toMatch(/token|secret|password|credential/i);
      }
    }
    expect(tools.some((tool) => /create_bridge|replace_bridge/.test(tool.name))).toBe(false);
    for (const name of ["thalovant_list_chat_app_connectors", "thalovant_update_bridge", "thalovant_delete_bridge"]) {
      expect(tools.find((tool) => tool.name === name)?.description, name).toMatch(/console/);
    }
  }, 15_000);

  it("requires control-plane auth and makes no request without it", async () => {
    const fake = await startFakeControlPlane(() => ({ body: {} }));
    const client = await connectStdioClient({ THALOVANT_API_URL: fake.url });
    expect(await callError(client, "thalovant_list_bridges", {})).toContain("THALOVANT_API_TOKEN");
    expect(fake.requests).toHaveLength(0);
  }, 15_000);
});

describe("chat app reads", () => {
  it("lists connectors in the language asked, with secrets by name and the settings form", async () => {
    const fake = await startFakeControlPlane((request) => request.path === "/v1/bridges/connectors" ? {
      body: {
        data: [{
          id: "twitch",
          name: "Twitch",
          mark: "twitch",
          status: "beta",
          description: { en: "Answer in Twitch chat.", fr: "Répondre dans le chat Twitch." },
          setup_steps: { en: "Make a Twitch app.", fr: null },
          config_schema: {
            type: "object",
            required: ["bot_login", "client_id"],
            properties: {
              bot_login: { type: "string", title: "Bot login", "x-title-fr": "Identifiant du bot" },
              client_id: { type: "string", title: "Client id" },
            },
          },
          secrets: [
            { key: "refresh_token", label: { en: "Refresh token", fr: "Jeton d'actualisation" }, required: true },
            { key: "client_secret", label: { en: "Client secret", fr: null }, required: true },
          ],
          targets: { label: { en: "Channels", fr: "Chaînes" }, pattern: "^[a-z0-9_]{4,25}$", max: 50, lowercase: true, strip_prefix: "#" },
          options: { require_mention_fixed: false, session_scopes: ["person", "chat"] },
          helpers: [],
          offered: false,
          version: null,
        }],
      },
    } : undefined);
    const client = await connectToApi(fake);

    const output = await callJson(client, "thalovant_list_chat_app_connectors", { language: "fr" });
    expect(only(fake, "GET", "/v1/bridges/connectors").headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(output.language).toBe("fr");
    expect(output.data[0]).toMatchObject({
      id: "twitch",
      status: "beta",
      offered: false,
      description: "Répondre dans le chat Twitch.",
      setup_steps: "Make a Twitch app.",
      secrets: [
        { key: "refresh_token", label: "Jeton d'actualisation", required: true },
        { key: "client_secret", label: "Client secret", required: true },
      ],
      settings: [
        { key: "bot_login", title: "Identifiant du bot", required: true },
        { key: "client_id", title: "Client id", required: true },
      ],
      targets: { pattern: "^[a-z0-9_]{4,25}$", lowercase: true, strip_prefix: "#", label: "Chaînes" },
      require_mention_fixed: false,
    });
    expect(output.next).toMatch(/console/);
    expect((await callJson(client, "thalovant_list_chat_app_connectors", {})).data[0].description).toBe("Answer in Twitch chat.");
  }, 15_000);

  it("shows the allowance of a hub's owner in words, and that a Free plan gets none", async () => {
    let plan = { plan: "Home", paid_plan: true, limit: 2, used: 1, remaining: 1, can_create: true };
    const fake = await startFakeControlPlane((request) => request.path === "/v1/bridges/networks" ? {
      body: {
        networks: [
          { network: "telegram", offered: true, name: "Telegram", mark: "telegram", status: "offered" },
          { network: "discord", offered: false, name: "Discord", mark: "discord", status: "offered" },
        ],
        allowance: { owner_id: OWNER_ID, ...plan },
      },
    } : undefined);
    const client = await connectToApi(fake);

    const home = await callJson(client, "thalovant_get_bridge_networks", { hubId: HUB_ID });
    expect(fake.requests[0].query).toEqual({ hub_id: HUB_ID });
    expect(home.networks).toEqual([
      { network: "telegram", name: "Telegram", status: "offered", offered: true },
      { network: "discord", name: "Discord", status: "offered", offered: false },
    ]);
    expect(home.allowance).toMatchObject({ plan: "Home", limit: 2, used: 1, remaining: 1, can_create: true });
    expect(home.summary).toMatch(/1 of 2 chat apps used/);

    plan = { plan: "Free", paid_plan: false, limit: 0, used: 0, remaining: 0, can_create: false };
    const free = await callJson(client, "thalovant_get_bridge_networks", {});
    expect(fake.requests[1].query).toEqual({});
    expect(free.summary).toMatch(/Free plans get 0/);
  }, 15_000);

  it("lists bridges with the status in words, never the platform's message or a credential", async () => {
    const fake = await startFakeControlPlane((request) => request.path === "/v1/bridges" ? {
      body: {
        data: [
          wireBridge({ token: "5550001:AAH-should-not-appear" }),
          wireBridge(
            { id: "9c4d5e6f-7a8b-4c3d-9e4f-5a6b7c8d9e0f", network: "matrix", paused: true, hold: { reason: "plan_limit", since: "2026-11-02T08:00:00Z" }, settings: { homeserver: "https://matrix.example.org", access_token: "syt_should-not-appear" }, secrets_set: ["access_token"], invite_links: null },
            { phase: "Paused", ready: false, reason: "Paused", applied: false, message: "platform-diagnostic-paused", operator_reason: "PlatformConditionPaused" },
          ),
        ],
      },
    } : undefined);
    const client = await connectToApi(fake);

    const result = await client.callTool({ name: "thalovant_list_bridges", arguments: { hubId: HUB_ID, ownerId: OWNER_ID, limit: 500 } });
    const text = resultText(result);
    expect(result.isError ?? false, text).toBe(false);
    expect(fake.requests[0].query).toEqual({ hub_id: HUB_ID, owner_id: OWNER_ID, limit: "500" });
    expect(text).not.toMatch(/should-not-appear|platform-diagnostic|PlatformCondition|operator_reason/);

    const [telegram, matrix] = JSON.parse(text).data;
    expect(telegram.status).toEqual({ reason: "Connected", phase: "Ready", ready: true, applied: true, summary: "Connected: the bridge is running and answers in its allowed chats. Every change is applied." });
    expect(telegram).toMatchObject({ etag: "etag-7", secrets_set: ["token"], allowed: [{ id: "-1001", title: "Family", kind: "supergroup" }] });
    expect(matrix.hold).toEqual({ reason: "plan_limit", since: "2026-11-02T08:00:00Z" });
    expect(matrix.status.summary).toMatch(/^Paused\. The platform paused it on 2026-11-02T08:00:00Z because the plan allows fewer running chat apps.*A change is still on its way to the bridge\.$/);
    expect(matrix.settings).toEqual({ homeserver: "https://matrix.example.org", access_token: "[redacted]" });
    expect(matrix.secrets_set).toEqual(["access_token"]);
  }, 15_000);

  it("refuses an out-of-range limit or a malformed id before any request", async () => {
    const fake = await startFakeControlPlane(() => ({ body: { data: [] } }));
    const client = await connectToApi(fake);
    for (const args of [{ limit: 0 }, { limit: 501 }, { hubId: "kitchen" }]) {
      await callError(client, "thalovant_list_bridges", args);
    }
    await callError(client, "thalovant_get_bridge", { bridgeId: "not-a-uuid" });
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it.each([
    ["TokenRejected", "Error", /^Token rejected: the chat network refused the bridge's credentials\. Paste new ones in the Thalovant console/],
    ["TokenMissing", "Pending", /^Token missing/],
    ["Setup", "Setup", /^Setting up: no chats are chosen yet/],
    ["Unavailable", "Degraded", /^Unavailable/],
  ])("words a %s bridge", async (reason, phase, summary) => {
    const fake = await startFakeControlPlane((request) => request.path === BRIDGE_PATH ? { body: wireBridge({}, { reason, phase, ready: false, applied: null }) } : undefined);
    const client = await connectToApi(fake);
    const bridge = await callJson(client, "thalovant_get_bridge", { bridgeId: BRIDGE_ID });
    expect(bridge.status.reason).toBe(reason);
    expect(bridge.status.phase).toBe(phase);
    expect(bridge.status.summary).toMatch(summary);
  }, 15_000);

  it("lists the chats a bot can see, and says how to type them when it cannot", async () => {
    let manual = false;
    const fake = await startFakeControlPlane((request) => request.path === `${BRIDGE_PATH}/chats` ? {
      body: manual
        ? { network: "matrix", data: [], note: null, manual_entry: true }
        : { network: "discord", data: [{ id: "42", title: "general", kind: "text", guild_id: "7", guild_name: "Home", guild_icon_url: null, allowed: true }], note: "Channels the bot can see." },
    } : undefined);
    const client = await connectToApi(fake);

    const listed = await callJson(client, "thalovant_list_bridge_chats", { bridgeId: BRIDGE_ID });
    expect(listed).toMatchObject({ network: "discord", manual_entry: false, note: "Channels the bot can see." });
    expect(listed.data).toEqual([{ id: "42", title: "general", kind: "text", guild_id: "7", guild_name: "Home", guild_icon_url: null, allowed: true, encrypted: false, selectable: true }]);
    manual = true;
    expect((await callJson(client, "thalovant_list_bridge_chats", { bridgeId: BRIDGE_ID })).next).toMatch(/type each id yourself/);
  }, 15_000);

  it("tells a model to pause a running Telegram bridge before listing its chats", async () => {
    const fake = await startFakeControlPlane(() => refusal(409, "bridge_running", "Pause the bridge to look for new chats."));
    const client = await connectToApi(fake);
    const text = await callError(client, "thalovant_list_bridge_chats", { bridgeId: BRIDGE_ID });
    expect(text).toContain("HTTP 409");
    expect(text).toContain("code: bridge_running");
    expect(text).toMatch(/Pause it with thalovant_pause_bridge/);
  }, 15_000);

  it("explains a bridge this token cannot see", async () => {
    const fake = await startFakeControlPlane(() => ({ status: 404, body: { detail: "Bridge not found" } }));
    const client = await connectToApi(fake);
    expect(await callError(client, "thalovant_get_bridge", { bridgeId: BRIDGE_ID })).toMatch(/Bridge not found[\s\S]*thalovant_list_bridges lists the visible ones/);
  }, 15_000);
});

describe("chat app writes", () => {
  /** Answers a PATCH with the bridge it would make, and remembers the bodies. */
  function patchResponder(status: Record<string, unknown> = {}) {
    return (request: RecordedRequest): FakeResponse | undefined => {
      if (request.method !== "PATCH" || request.path !== BRIDGE_PATH) return undefined;
      const paused = request.body?.paused === true;
      return {
        body: wireBridge(
          { ...(request.body ?? {}), paused, operation: { id: "op-9", kind: "bridge.sync", status: "requested", access_token: "op-should-not-appear" } },
          paused ? { phase: "Paused", reason: "Paused", ready: false, applied: false, ...status } : { applied: false, ...status },
        ),
      };
    };
  }

  it("pauses and resumes with paused alone, and sends If-Match only when an etag is given", async () => {
    const fake = await startFakeControlPlane(patchResponder());
    const client = await connectToApi(fake);

    const paused = await callJson(client, "thalovant_pause_bridge", { bridgeId: BRIDGE_ID, etag: "etag-7" });
    expect(fake.requests[0].body).toEqual({ paused: true });
    expect(fake.requests[0].headers["if-match"]).toBe("etag-7");
    expect(paused.status.summary).toMatch(/^Paused by its owner.*A change is still on its way to the bridge\.$/);
    expect(paused.operation).toMatchObject({ id: "op-9", access_token: "[redacted]" });
    expect(JSON.stringify(paused)).not.toContain("op-should-not-appear");

    await callJson(client, "thalovant_resume_bridge", { bridgeId: BRIDGE_ID });
    expect(fake.requests[1].body).toEqual({ paused: false });
    expect(fake.requests[1].headers["if-match"]).toBeUndefined();
  }, 15_000);

  it("explains a resume the plan has no room for, and a plan without chat apps", async () => {
    let answer = refusal(403, "plan_limit", "Your plan runs 2 chat apps.", { resource: "chat_bridge", limit: 2, used: 2, plan: "Home" });
    const fake = await startFakeControlPlane(() => answer);
    const client = await connectToApi(fake);

    const full = await callError(client, "thalovant_resume_bridge", { bridgeId: BRIDGE_ID });
    expect(full).toContain("code: plan_limit");
    expect(full).toMatch(/"resource":"chat_bridge"/);
    expect(full).toMatch(/chat-app allowance is used/);

    answer = { status: 402, body: { detail: "API access requires a paid plan." } };
    expect(await callError(client, "thalovant_resume_bridge", { bridgeId: BRIDGE_ID })).toMatch(/Free plans get 0/);
  }, 15_000);

  it("explains a stale etag", async () => {
    const fake = await startFakeControlPlane(() => ({ status: 412, body: { detail: "ETag mismatch" } }));
    const client = await connectToApi(fake);
    const text = await callError(client, "thalovant_pause_bridge", { bridgeId: BRIDGE_ID, etag: "stale" });
    expect(text).toMatch(/ETag mismatch[\s\S]*Read it again with thalovant_get_bridge/);
  }, 15_000);

  it("updates chats, mention rule, session scope and settings in snake case, with the etag", async () => {
    const fake = await startFakeControlPlane(patchResponder());
    const client = await connectToApi(fake);

    const bridge = await callJson(client, "thalovant_update_bridge", {
      bridgeId: BRIDGE_ID,
      allowed: [{ id: "-1001", title: "Family", kind: "supergroup" }, { id: "42", guild_id: "7", guild_name: "Home" }],
      requireMention: false,
      sessionScope: "chat",
      settings: { homeserver: "https://matrix.example.org" },
      etag: "etag-7",
    });
    const request = only(fake, "PATCH", BRIDGE_PATH);
    expect(request.headers["if-match"]).toBe("etag-7");
    expect(request.body).toEqual({
      allowed: [{ id: "-1001", title: "Family", kind: "supergroup" }, { id: "42", guild_id: "7", guild_name: "Home" }],
      require_mention: false,
      session_scope: "chat",
      settings: { homeserver: "https://matrix.example.org" },
    });
    expect(bridge.status.summary).toMatch(/A change is still on its way to the bridge\.$/);
  }, 15_000);

  it("refuses an empty change, an empty chat list and a setting that looks like a secret, before any request", async () => {
    const fake = await startFakeControlPlane(patchResponder());
    const client = await connectToApi(fake);

    expect(await callError(client, "thalovant_update_bridge", { bridgeId: BRIDGE_ID })).toMatch(/Nothing to change/);
    await callError(client, "thalovant_update_bridge", { bridgeId: BRIDGE_ID, allowed: [] });
    await callError(client, "thalovant_update_bridge", { bridgeId: BRIDGE_ID, allowed: [{ id: "has space" }] });
    await callError(client, "thalovant_update_bridge", { bridgeId: BRIDGE_ID, sessionScope: "everyone" });
    await callError(client, "thalovant_update_bridge", {
      bridgeId: BRIDGE_ID,
      settings: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`setting_${index}`, "x"])),
    });
    const secret = await callError(client, "thalovant_update_bridge", {
      bridgeId: BRIDGE_ID,
      settings: { homeserver: "https://matrix.example.org", access_token: "syt_should-not-appear" },
    });
    expect(secret).toMatch(/access_token looks like one, so nothing was sent/);
    expect(secret).toMatch(/Replace token/);
    expect(secret).not.toContain("syt_should-not-appear");
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("names the settings a refusal is about, never their values", async () => {
    const fake = await startFakeControlPlane(() => refusal(422, "bridge_url_not_public", "The homeserver must be a public address.", { fields: ["homeserver"] }));
    const client = await connectToApi(fake);
    const text = await callError(client, "thalovant_update_bridge", { bridgeId: BRIDGE_ID, settings: { homeserver: "https://10.0.0.5" } });
    expect(text).toContain("code: bridge_url_not_public");
    expect(text).toMatch(/The API named the settings: homeserver/);
    expect(text).toMatch(/https on port 443/);
    expect(text).not.toContain("10.0.0.5");
  }, 15_000);

  it("explains the mention rule a Discord bridge cannot drop", async () => {
    const fake = await startFakeControlPlane(() => refusal(422, "bridge_mention_required", "A Discord bridge answers mentions only."));
    const client = await connectToApi(fake);
    expect(await callError(client, "thalovant_update_bridge", { bridgeId: BRIDGE_ID, requireMention: false })).toMatch(/requireMention cannot be false/);
  }, 15_000);

  it("sends a test message to an allowed chat", async () => {
    const fake = await startFakeControlPlane((request) => request.method === "POST" && request.path === `${BRIDGE_PATH}/test`
      ? { body: { sent: true, chat_id: request.body?.chat_id, language: "fr" } }
      : undefined);
    const client = await connectToApi(fake);
    expect(await callJson(client, "thalovant_send_bridge_test_message", { bridgeId: BRIDGE_ID, chatId: "-1001" })).toEqual({ sent: true, chat_id: "-1001", language: "fr" });
    expect(only(fake, "POST", `${BRIDGE_PATH}/test`).body).toEqual({ chat_id: "-1001" });
  }, 15_000);

  it("explains the test message refusals, with the wait after a rate limit", async () => {
    let answer = refusal(409, "bridge_helper_unavailable", "This chat app has no test message.");
    const fake = await startFakeControlPlane(() => answer);
    const client = await connectToApi(fake);
    const args = { bridgeId: BRIDGE_ID, chatId: "!room:example.org" };

    expect(await callError(client, "thalovant_send_bridge_test_message", args)).toMatch(/Mention the bot in one of its allowed chats/);
    answer = refusal(422, "bridge_chat_not_allowed", "A test message goes only to an allowed chat.");
    expect(await callError(client, "thalovant_send_bridge_test_message", args)).toMatch(/add the chat with thalovant_update_bridge first/);
    answer = { ...refusal(429, "bridge_rate_limited", "Too many test messages."), headers: { "Retry-After": "90" } };
    expect(await callError(client, "thalovant_send_bridge_test_message", args)).toMatch(/Wait 90 seconds/);
  }, 15_000);

  it("deletes a bridge only when destructive tools are enabled", async () => {
    const fake = await startFakeControlPlane((request) => request.method === "DELETE" && request.path === BRIDGE_PATH ? { status: 204, body: null } : undefined);
    const off = await connectToApi(fake);
    expect(await callError(off, "thalovant_delete_bridge", { bridgeId: BRIDGE_ID })).toMatch(/not found/i);
    expect(fake.requests).toHaveLength(0);

    const on = await connectToApi(fake, { THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "true" });
    expect(await callJson(on, "thalovant_delete_bridge", { bridgeId: BRIDGE_ID })).toEqual({ deleted: true, bridgeId: BRIDGE_ID });
    only(fake, "DELETE", BRIDGE_PATH);
  }, 15_000);

  it("keeps the delete tool deniable by policy once enabled", async () => {
    const fake = await startFakeControlPlane(() => ({ status: 204, body: null }));
    const client = await connectToApi(fake, { THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "true", MCP_TOOL_DENYLIST: "thalovant_delete_bridge" });
    expect(await callError(client, "thalovant_delete_bridge", { bridgeId: BRIDGE_ID })).toMatch(/disabled by server policy/);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);
});
