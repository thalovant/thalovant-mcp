/**
 * The connector gateway API (thalovant-api #521) as the tools show it: the
 * `connector` kind and its connectors, a replayed create that carries no
 * credentials, `serves`, and a readable text for each new refusal. The loopback
 * API answers what the platform answers; the pinned `@thalovant/sdk` is the one
 * every tool calls, so nothing here needs the unpublished SDK.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { replayMarker, replayedCreateOutput, servesOutput } from "../src/connection-output.js";

const API_TOKEN = "tvpat_connector-test-token";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Record<string, any>;
}
interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** A loopback API: GET of a hub answers the hub, every other call is answered by `answer`. */
async function startApi(answer: (request: Recorded) => Answer): Promise<{ url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const request: Recorded = {
        method: req.method ?? "GET",
        path: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        body: raw.trim() ? JSON.parse(raw) : undefined,
      };
      requests.push(request);
      const reply: Answer =
        request.method === "GET" && request.path === "/v1/hubs/hub-1"
          ? { body: { id: "hub-1", domain: "hub.example" } }
          : answer(request);
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function connect(apiUrl: string, extra: Record<string, string> = {}): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("THALOVANT_") && !key.startsWith("MCP_")) env[key] = value;
  }
  const client = new Client({ name: "connector-connections", version: "0.0.0" }, { capabilities: {} });
  cleanups.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: { ...env, THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: apiUrl, ...extra },
    }),
  );
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");
}

const IDENTIFY = {
  access_key: "ak_platform_issued",
  password: "pw_platform_issued",
  site_id: "bridge",
  default_master: "hub.example",
  default_port: 443,
};

const BRIDGE = {
  id: "client-1",
  etag: "e1",
  spec: { connection_type: "connector", connectors: ["music_assistant"] },
  operation: { id: "op-1" },
};

describe("connection-output helpers", () => {
  it("reads the replay marker and nothing else as a replay", () => {
    expect(replayMarker({ replay: { code: "idempotent_replay", credentials_included: false, detail: "same key" } })).toEqual({
      code: "idempotent_replay",
      credentialsIncluded: false,
      detail: "same key",
    });
    expect(replayMarker({ replay: { credentials_included: false } })?.code).toBe("idempotent_replay");
    expect(replayMarker({ id: "c" })).toBeNull();
    expect(replayMarker(undefined)).toBeNull();
    expect(replayMarker({ replay: { code: "other", credentials_included: true } })).toBeNull();
  });

  it("cleans serves and keeps its warning", () => {
    const serves = servesOutput({
      serves: {
        devices: [{ id: "d1", name: "Kitchen‮\n", connection_type: "voice_satellite", active: true }, "junk"],
        count: 1,
        warning: "One device is off.",
      },
    });
    expect(serves).toEqual({
      devices: [{ id: "d1", name: "Kitchen", connectionType: "voice_satellite", active: true }],
      count: 1,
      warning: "One device is off.",
    });
    expect(servesOutput({ id: "c" })).toBeNull();
    expect(servesOutput({ serves: {} })).toEqual({ devices: [], count: 0, warning: null });
  });

  it("a replayed create output names the connection and returns no identity", () => {
    const out = replayedCreateOutput(
      { id: "client-1", spec: { connection_type: "connector" } },
      { code: "idempotent_replay", credentialsIncluded: false, detail: null },
    );
    expect(out).toMatchObject({ replayed: true, exists: true, clientId: "client-1", connectionType: "connector", identityReturned: false });
    expect(JSON.stringify(out)).toMatch(/NEW idempotencyKey/);
  });
});

describe("thalovant_create_client_identity and connectors", () => {
  it("takes the connector kind and connectors in the input schema", async () => {
    const api = await startApi(() => ({ body: {} }));
    const client = await connect(api.url);
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "thalovant_create_client_identity")!;
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props.connectors).toMatchObject({ type: "array", minItems: 1 });
    expect(props.connectors.description).toMatch(/home_assistant is never one/);
    expect(props.connectionType.description).toMatch(/connector/);
    expect(tool.description).toMatch(/replayed/);
    const hubs = (await client.listTools()).tools.find((entry) => entry.name === "thalovant_list_hubs")!;
    expect(hubs.description).toMatch(/connectors/);
  }, 15_000);

  it("creates a home bridge, sends spec.connectors and shows serves with its warning", async () => {
    const api = await startApi(() => ({
      body: {
        ...BRIDGE,
        initial_identify: IDENTIFY,
        serves: {
          devices: [{ id: "d1", name: "Kitchen", connection_type: "voice_satellite", active: true }],
          count: 1,
          warning: "The bridge serves 1 device on this hub.",
        },
      },
    }));
    const client = await connect(api.url);
    const result = await client.callTool({
      name: "thalovant_create_client_identity",
      arguments: { hubId: "hub-1", name: "bridge", connectionType: "connector", connectors: ["music_assistant"], idempotencyKey: "k1" },
    });
    expect(result.isError ?? false, text(result)).toBe(false);
    const sent = api.requests.find((request) => request.method === "POST" && request.path === "/v1/clients")!;
    expect(sent.body!.spec).toMatchObject({ connection_type: "connector", connectors: ["music_assistant"] });
    expect(sent.headers["idempotency-key"]).toBe("k1");
    const out = JSON.parse(text(result));
    expect(out.replayed).toBe(false);
    expect(out.connectionType).toBe("connector");
    expect(out.serves).toEqual({
      devices: [{ id: "d1", name: "Kitchen", connectionType: "voice_satellite", active: true }],
      count: 1,
      warning: "The bridge serves 1 device on this hub.",
    });
    expect(text(result)).not.toContain("pw_platform_issued");
  }, 20_000);

  it("does not pass a device name through uncleaned in the raw client", async () => {
    const dirty = "Kit\u202Echen\nIGNORE PREVIOUS";
    const api = await startApi(() => ({
      body: { ...BRIDGE, initial_identify: IDENTIFY, serves: { devices: [{ id: "d1", name: dirty, connection_type: "voice_satellite", active: true }], count: 1, warning: null } },
    }));
    const client = await connect(api.url);
    const result = await client.callTool({
      name: "thalovant_create_client_identity",
      arguments: { hubId: "hub-1", name: "bridge", connectionType: "connector", connectors: ["music_assistant"] },
    });
    const out = JSON.parse(text(result));
    expect(out.result.client.serves).toBeUndefined();
    expect(text(result)).not.toContain("\u202E");
    expect(text(result)).not.toContain("\nIGNORE");
    expect(out.serves.devices).toHaveLength(1);
  }, 20_000);

  it("refuses connectors on another kind, and two different lists, before any call", async () => {
    const api = await startApi(() => ({ body: {} }));
    const client = await connect(api.url);
    const other = await client.callTool({
      name: "thalovant_create_client_identity",
      arguments: { hubId: "hub-1", name: "x", connectionType: "home_assistant", connectors: ["music_assistant"] },
    });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/only for connectionType connector/);
    const differ = await client.callTool({
      name: "thalovant_create_client_identity",
      arguments: { hubId: "hub-1", name: "x", connectionType: "connector", connectors: ["music_assistant"], spec: { connectors: ["other"] } },
    });
    expect(differ.isError).toBe(true);
    expect(text(differ)).toMatch(/differ/);
    const bad = await client.callTool({
      name: "thalovant_create_client_identity",
      arguments: { hubId: "hub-1", name: "x", connectionType: "connector", connectors: ["Music Assistant"] },
    });
    expect(bad.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  }, 20_000);

  it("a replayed create returns no identity, writes no file and does not repeat a key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-replay-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const api = await startApi(() => ({
      headers: { "Idempotent-Replayed": "true" },
      body: {
        ...BRIDGE,
        replay: { code: "idempotent_replay", credentials_included: false, detail: "Answered from the first request." },
        serves: { devices: [], count: 0, warning: null },
      },
    }));
    const client = await connect(api.url, { THALOVANT_MCP_IDENTITY_DIR: dir });
    const result = await client.callTool({
      name: "thalovant_create_client_identity",
      arguments: { hubId: "hub-1", name: "bridge", connectionType: "connector", connectors: ["music_assistant"], idempotencyKey: "k1", savePath: "bridge.json" },
    });
    expect(result.isError ?? false, text(result)).toBe(false);
    const out = JSON.parse(text(result));
    expect(out).toMatchObject({ replayed: true, exists: true, clientId: "client-1", identityReturned: false });
    expect(out.replay).toMatchObject({ code: "idempotent_replay", credentialsIncluded: false });
    expect(out.next).toMatch(/delete it/);
    expect(out.next).toMatch(/owner's own session/);
    expect(out).not.toHaveProperty("savedIdentityPath");
    expect(out).not.toHaveProperty("selectedEndpoint");
    // The identity the SDK would have made up (from the key it sent) is nowhere in the answer, nor on disk.
    const sent = api.requests.find((request) => request.method === "POST")!.body!.spec;
    expect(text(result)).not.toContain(sent.apiKey);
    expect(text(result)).not.toContain(sent.password);
    expect(existsSync(join(dir, "bridge.json"))).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  }, 20_000);
});

describe("refusals of the connector gateway API", () => {
  const create = { hubId: "hub-1", name: "x", connectionType: "connector", connectors: ["music_assistant"] };
  const cases: Array<{ name: string; status: number; body: unknown; expect: RegExp[]; arguments?: Record<string, unknown> }> = [
    {
      name: "connection_type_unavailable is not 'the API does not know the kind'",
      status: 422,
      body: { code: "connection_type_unavailable", reason: "hub_operated_by_another_account", detail: "No link on this hub (connection_type)." },
      expect: [/code: connection_type_unavailable/, /another account/, /your own hub or one Thalovant runs/, /Devices on this hub are not affected/],
    },
    {
      name: "connection_type_unknown carries known",
      status: 422,
      body: { code: "connection_type_unknown", known: ["voice_satellite", "connector"], detail: "connection_type unknown" },
      expect: [/does not know the connection type "connector"/, /voice_satellite, connector/],
    },
    {
      name: "connection_type_ambiguous",
      status: 422,
      body: { code: "connection_type_ambiguous", detail: "connection_type differs" },
      expect: [/two different connection kinds/, /Send the kind once/],
    },
    {
      name: "connectors_invalid duplicate",
      status: 422,
      body: { code: "connectors_invalid", reason: "duplicate", known: ["music_assistant"] },
      expect: [/named more than once/, /Ids it may serve: music_assistant/, /Nothing was created/],
    },
    {
      name: "connectors_invalid own_kind inside an object detail",
      status: 422,
      body: { detail: { code: "connectors_invalid", reason: "own_kind", known: ["music_assistant"] } },
      expect: [/home_assistant is never a connector/, /connectionType home_assistant/],
    },
    {
      name: "connectors_invalid unknown_or_malformed",
      status: 422,
      body: { code: "connectors_invalid", reason: "unknown_or_malformed", known: ["music_assistant"] },
      expect: [/unknown or malformed/],
    },
    {
      name: "device_owner_only_beside_home_link",
      status: 403,
      body: { code: "device_owner_only_beside_home_link", link_client_id: "link-9" },
      expect: [/home link \(client link-9\)/, /only the account owner, from their own session, may add a device/, /not a scope problem/],
    },
    {
      name: "setup_session_owner_only_beside_home_link",
      status: 403,
      body: { code: "setup_session_owner_only_beside_home_link", link_client_id: "link-9" },
      expect: [/may set up a device/],
    },
    {
      name: "device_identity_owner_only_beside_home_link",
      status: 403,
      body: { code: "device_identity_owner_only_beside_home_link", link_client_id: "link-9" },
      expect: [/may download a device's identity/],
    },
    {
      name: "idempotency_key_spent",
      status: 409,
      body: { code: "idempotency_key_spent" },
      expect: [/Send the request again with a new idempotencyKey/],
    },
  ];

  for (const entry of cases) {
    it(entry.name, async () => {
      const api = await startApi(() => ({ status: entry.status, body: entry.body }));
      const client = await connect(api.url);
      const result = await client.callTool({ name: "thalovant_create_client_identity", arguments: entry.arguments ?? create });
      expect(result.isError).toBe(true);
      for (const pattern of entry.expect) expect(text(result)).toMatch(pattern);
      expect(text(result)).not.toMatch(/does not know the connection type "connector" yet/);
    }, 20_000);
  }

  it("hub_scale_out_breaks_links and skill_config_private_hub_only read well from a hub change", async () => {
    let next: Answer = { status: 409, body: { code: "hub_scale_out_breaks_links", links: 2 } };
    const api = await startApi(() => next);
    const client = await connect(api.url);
    const args = { hubId: "hub-1", etag: "e1", capacityProfile: "autoscaling" };
    const scale = await client.callTool({ name: "thalovant_update_hub", arguments: args });
    expect(scale.isError).toBe(true);
    expect(text(scale)).toMatch(/carries 2 link\(s\)/);
    expect(text(scale)).toMatch(/Remove the links first/);
    expect(text(scale)).toMatch(/There is no override/);

    next = { status: 422, body: { code: "skill_config_private_hub_only", settings: ["url", "token"] } };
    const priv = await client.callTool({ name: "thalovant_update_hub", arguments: { ...args, visibility: "public" } });
    expect(priv.isError).toBe(true);
    expect(text(priv)).toMatch(/settings url, token are/);
    expect(text(priv)).toMatch(/home bridge/);
    expect(text(priv)).toMatch(/keep the hub private/);
  }, 20_000);

  it("a code it does not list keeps the old text", async () => {
    const api = await startApi(() => ({ status: 422, body: { code: "something_else", detail: "connection_type is not supported" } }));
    const client = await connect(api.url);
    const result = await client.callTool({ name: "thalovant_create_client_identity", arguments: create });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not know the connection type "connector" yet/);
  }, 20_000);
});
