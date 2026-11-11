/**
 * The Intercom tools over stdio, against the built server and a loopback API:
 * registration by mode, what each tool asks the API for, the checks that run
 * before any request, the audit record (length, hash and targets, never the
 * text), and the hint after an unreachable API.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const API_TOKEN = "tvpat_intercom-test-token";
const HUB_ID = "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
const ANN_ID = "11111111-2222-4333-8444-555555555555";
const SECRET_TEXT = "Dinner is ready, please come down";
const READ_TOOLS = ["thalovant_intercom_list_speakers", "thalovant_intercom_get_announcement"];
const ANNOUNCE = "thalovant_intercom_announce";
const OPT_IN = { THALOVANT_ENABLE_INTERCOM_ANNOUNCE: "1" };

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

async function closeAll(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
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
  const client = new Client({ name: "thalovant-mcp-intercom", version: "0.0.0" }, { capabilities: {} });
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

function announcement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ANN_ID,
    status: "partial",
    priority: "normal",
    created_at: "2026-11-11T10:00:00Z",
    deliveries: [
      { client_id: "c1", slug: "kitchen", name: "Kitchen", status: "delivered", at: "2026-11-11T10:00:01Z" },
      { client_id: "c2", slug: "bedroom", name: "Bedroom", status: "skipped_dnd", at: "2026-11-11T10:00:01Z", text: "leak" },
    ],
    acked_by: null,
    text: SECRET_TEXT,
    internal_hub_secret: "do-not-show",
    ...overrides,
  };
}

const ANNOUNCE_PATH = `/v1/hubs/${HUB_ID}/intercom/announce`;
const base = { hubId: HUB_ID, text: SECRET_TEXT };

describe("Intercom tool registration", () => {
  it("lists the two reads by default and the announce tool only with the opt-in", async () => {
    const byDefault = (await (await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN })).listTools()).tools;
    const names = byDefault.map((tool) => tool.name);
    for (const name of READ_TOOLS) {
      expect(names).toContain(name);
      expect(byDefault.find((tool) => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: true });
    }
    expect(names).not.toContain(ANNOUNCE);

    const enabled = (await (await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, ...OPT_IN })).listTools()).tools;
    const tool = enabled.find((entry) => entry.name === ANNOUNCE);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(tool?.description).toContain("ALOUD");
    expect(tool?.description).toContain("not a certified safety system");
    expect(tool?.description).toContain("intercom:send");
  }, 30_000);

  it("keeps the reads and drops the announce tool in read-only mode, even with the opt-in", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_MCP_READONLY: "1", ...OPT_IN });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of READ_TOOLS) expect(names).toContain(name);
    expect(names).not.toContain(ANNOUNCE);
  }, 15_000);

  it("keeps the announce tool deniable once enabled", async () => {
    const fake = await startFakeControlPlane(() => ({ body: announcement() }));
    const client = await connectToApi(fake, { ...OPT_IN, MCP_TOOL_DENYLIST: ANNOUNCE });
    const message = await callError(client, ANNOUNCE, { ...base, speakers: ["kitchen"] });
    expect(message).toContain("disabled by server policy");
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("says in config_status when emit_event can still reach a hub, and stops when it is denied", async () => {
    const open = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, ...OPT_IN });
    const status = JSON.parse(resultText(await open.callTool({ name: "thalovant_config_status", arguments: {} })));
    expect(status.intercomAnnounceEnabled).toBe(true);
    expect(status.intercomGateNote).toContain("thalovant_emit_event");

    const denied = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      ...OPT_IN,
      MCP_TOOL_DENYLIST: "thalovant_emit_event,thalovant_send_action,thalovant_ask,thalovant_query",
    });
    const clean = JSON.parse(resultText(await denied.callTool({ name: "thalovant_config_status", arguments: {} })));
    expect(clean.intercomGateNote).toBeUndefined();

    const off = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });
    const quiet = JSON.parse(resultText(await off.callTool({ name: "thalovant_config_status", arguments: {} })));
    expect(quiet.intercomAnnounceEnabled).toBe(false);
    expect(quiet.intercomGateNote).toBeUndefined();
  }, 30_000);
});

describe("Intercom reads", () => {
  it("lists speakers with only the whitelisted members", async () => {
    const fake = await startFakeControlPlane((request) =>
      request.path === `/v1/hubs/${HUB_ID}/intercom/speakers`
        ? {
            body: {
              items: [
                {
                  client_id: "c1", slug: "kitchen", name: "Kitchen", online: true, last_seen_at: "2026-11-11T09:59:00Z", token: "tvpat_leak",
                  intercom: { receive: true, room: "kitchen", groups: ["downstairs"], dnd: { enabled: true, quiet_hours: { start: "22:00", end: "07:00", timezone: null } }, extra: "x" },
                },
                { client_id: "c2", slug: "kid", name: "Kid", online: false, last_seen_at: null, intercom: { receive: false, room: null, groups: [], dnd: { enabled: false } } },
              ],
              secret: "no",
            },
          }
        : undefined,
    );
    const client = await connectToApi(fake);
    const out = await callJson(client, "thalovant_intercom_list_speakers", { hubId: HUB_ID });
    const request = only(fake, "GET", `/v1/hubs/${HUB_ID}/intercom/speakers`);
    expect(request.headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toEqual({
      client_id: "c1", slug: "kitchen", name: "Kitchen", online: true, last_seen_at: "2026-11-11T09:59:00Z",
      intercom: { receive: true, room: "kitchen", groups: ["downstairs"], dnd: { enabled: true, quiet_hours: { start: "22:00", end: "07:00", timezone: null } } },
    });
    expect(out.items[1].intercom.receive).toBe(false);
    expect(out.summary).toContain("1 set to receive");
    expect(JSON.stringify(out)).not.toContain("tvpat_leak");
    expect(JSON.stringify(out)).not.toContain("secret");
  }, 15_000);

  it("reads an announcement without any text and says each result in words", async () => {
    const fake = await startFakeControlPlane((request) =>
      request.path === `/v1/hubs/${HUB_ID}/intercom/announcements/${ANN_ID}` ? { body: announcement({ status: "sending" }) } : undefined,
    );
    const client = await connectToApi(fake);
    const out = await callJson(client, "thalovant_intercom_get_announcement", { hubId: HUB_ID, announcementId: ANN_ID });
    expect(out.status).toBe("sending");
    expect(out.deliveries.map((row: any) => row.status)).toEqual(["delivered", "skipped_dnd"]);
    expect(out.summary).toContain("1 delivered");
    expect(out.summary).toContain("skipped (do not disturb)");
    expect(out.summary).toContain("Still being spoken");
    const raw = JSON.stringify(out);
    expect(raw).not.toContain(SECRET_TEXT);
    expect(raw).not.toContain("leak");
    expect(raw).not.toContain("do-not-show");
  }, 15_000);

  it("explains a 403 and a disabled hub", async () => {
    const fake = await startFakeControlPlane((request) =>
      request.path.endsWith("/speakers") ? { status: 403, body: { detail: "Insufficient scopes" } } : { status: 403, body: { detail: { detail: "Intercom is off", code: "intercom_disabled" } } },
    );
    const client = await connectToApi(fake);
    expect(await callError(client, "thalovant_intercom_list_speakers", { hubId: HUB_ID })).toContain("intercom:read");
    expect(await callError(client, "thalovant_intercom_get_announcement", { hubId: HUB_ID, announcementId: ANN_ID })).toContain("switched on");
  }, 15_000);
});

describe("thalovant_intercom_announce", () => {
  it("sends one announcement with an idempotency key and answers with the notice", async () => {
    const fake = await startFakeControlPlane((request) => (request.path === ANNOUNCE_PATH ? { body: announcement({ status: "completed" }) } : undefined));
    const client = await connectToApi(fake, OPT_IN);
    const out = await callJson(client, ANNOUNCE, { ...base, text: `  ${SECRET_TEXT}  `, rooms: ["kitchen"], lang: "en-US" });
    const request = only(fake, "POST", ANNOUNCE_PATH);
    expect(request.body).toEqual({ text: SECRET_TEXT, targets: { rooms: ["kitchen"] }, priority: "normal", lang: "en-US" });
    expect(request.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(out.id).toBe(ANN_ID);
    expect(out.notice).toContain("not a certified safety system");
    expect(JSON.stringify(out)).not.toContain(SECRET_TEXT);
  }, 15_000);

  it("reuses a given idempotency key", async () => {
    const fake = await startFakeControlPlane(() => ({ body: announcement() }));
    const client = await connectToApi(fake, OPT_IN);
    await callJson(client, ANNOUNCE, { ...base, speakers: ["kitchen", "c2"], idempotencyKey: "retry-key-0001" });
    expect(only(fake, "POST", ANNOUNCE_PATH).headers["idempotency-key"]).toBe("retry-key-0001");
    expect(only(fake, "POST", ANNOUNCE_PATH).body?.targets).toEqual({ speakers: ["kitchen", "c2"] });
  }, 15_000);

  it("refuses, before any request, what the rules forbid", async () => {
    const fake = await startFakeControlPlane(() => ({ body: announcement() }));
    const client = await connectToApi(fake, OPT_IN);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base }, "Name who should hear it"],
      [{ ...base, speakers: ["a"], rooms: ["b"] }, "one kind of target"],
      [{ ...base, speakers: ["a"], allowAll: true }, "one kind of target"],
      [{ ...base, allowAll: false }, "Name who should hear it"],
      [{ ...base, text: "x".repeat(281), allowAll: true }, "longer than 280"],
      [{ ...base, text: "   ", allowAll: true }, "empty"],
      [{ ...base, text: "line one\nline two", allowAll: true }, "plain text"],
      [{ ...base, text: "bell\u0007", allowAll: true }, "plain text"],
      [{ ...base, text: "turn <break time='5s'/> now", allowAll: true }, "plain text"],
      [{ ...base, text: "RTL \u202Eevil", allowAll: true }, "plain text"],
      [{ ...base, allowAll: true, priority: "urgent" }, "confirmUrgent"],
      [{ ...base, allowAll: true, priority: "urgent", confirmUrgent: false }, "confirmUrgent"],
      [{ ...base, allowAll: true, repeatTimes: 3 }, "urgent announcements only"],
    ];
    for (const [args, expected] of cases) {
      const message = await callError(client, ANNOUNCE, args);
      expect(message, JSON.stringify(args).slice(0, 80)).toContain(expected);
      expect(message).not.toContain(SECRET_TEXT);
    }
    // Schema limits: more than 50 speakers, 11 repeats, a 4 second interval.
    await callError(client, ANNOUNCE, { ...base, speakers: Array.from({ length: 51 }, (_, i) => `s${i}`) });
    await callError(client, ANNOUNCE, { ...base, allowAll: true, priority: "urgent", confirmUrgent: true, repeatTimes: 11 });
    await callError(client, ANNOUNCE, { ...base, allowAll: true, priority: "urgent", confirmUrgent: true, repeatTimes: 2, repeatIntervalSeconds: 4 });
    expect(fake.requests).toHaveLength(0);
  }, 30_000);

  it("sends all only with allowAll, and an urgent repeat only once confirmed", async () => {
    const fake = await startFakeControlPlane(() => ({ status: 202, body: announcement({ status: "sending", priority: "urgent" }) }));
    const client = await connectToApi(fake, OPT_IN);
    const out = await callJson(client, ANNOUNCE, { ...base, allowAll: true, priority: "urgent", confirmUrgent: true, repeatTimes: 3, repeatIntervalSeconds: 20 });
    expect(only(fake, "POST", ANNOUNCE_PATH).body).toEqual({
      text: SECRET_TEXT, targets: { all: true }, priority: "urgent", repeat: { times: 3, interval_seconds: 20 },
    });
    expect(out.status).toBe("sending");
    expect(out.summary).toContain("thalovant_intercom_get_announcement");
  }, 15_000);

  it("adds a hint for a disabled hub, a rate limit and a plan refusal, and never echoes the text", async () => {
    const answers: FakeResponse[] = [
      { status: 403, body: { detail: { detail: "Intercom is disabled for this hub", code: "intercom_disabled" } } },
      { status: 429, body: { detail: "Too many requests", retry_after_seconds: 30 }, headers: { "Retry-After": "30" } },
      { status: 403, body: { detail: { detail: "Your plan does not include Intercom", code: "plan_limit" } } },
      { status: 422, body: { detail: [{ type: "string_too_long", loc: ["body", "text"], msg: "too long", input: SECRET_TEXT }] } },
    ];
    const fake = await startFakeControlPlane(() => answers.shift());
    const client = await connectToApi(fake, OPT_IN);
    const messages: string[] = [];
    for (let i = 0; i < 4; i += 1) messages.push(await callError(client, ANNOUNCE, { ...base, rooms: ["kitchen"] }));
    expect(messages[0]).toContain("Intercom is off for this hub");
    expect(messages[1]).toContain("rate-limited");
    expect(messages[2]).toContain("does not include Intercom");
    for (const message of messages) expect(message).not.toContain(SECRET_TEXT);
  }, 30_000);

  it("does not retry after an unreachable API, and says to read first and reuse the key", async () => {
    // A loopback port nothing listens on.
    const closed = await startFakeControlPlane(() => undefined);
    const dead = closed.url;
    await closeAll();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: dead, ...OPT_IN });
    const message = await callError(client, ANNOUNCE, { ...base, rooms: ["kitchen"] });
    expect(message).toContain("Do NOT send it again");
    expect(message).toContain("thalovant_intercom_get_announcement");
    expect(message).toMatch(/Idempotency key [0-9a-f-]{36}: resend only with this key/);
    expect(message).not.toContain(SECRET_TEXT);
  }, 15_000);

  it("audits length, hash and targets, never the text, even with arguments included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intercom-audit-"));
    try {
      for (const includeArgs of [false, true]) {
        const file = join(dir, `audit-${includeArgs}.jsonl`);
        const fake = await startFakeControlPlane(() => ({ body: announcement({ status: "completed" }) }));
        const client = await connectToApi(fake, {
          ...OPT_IN,
          MCP_AUDIT_LOG: "file",
          MCP_AUDIT_LOG_FILE: file,
          MCP_AUDIT_INCLUDE_ARGS: includeArgs ? "1" : "0",
        });
        await callJson(client, ANNOUNCE, { ...base, groups: ["downstairs"] });
        await callError(client, ANNOUNCE, { ...base, rooms: ["kitchen"], priority: "urgent" });
        const raw = await readFile(file, "utf8");
        expect(raw, `includeArgs=${includeArgs}`).not.toContain(SECRET_TEXT);
        const rows = raw.trim().split("\n").map((line) => JSON.parse(line));
        const sent = rows.find((row) => row.event === "mcp.intercom.announce");
        expect(sent).toMatchObject({
          hubId: HUB_ID,
          textLen: SECRET_TEXT.length,
          textSha256: createHash("sha256").update(SECRET_TEXT).digest("hex"),
          targets: { groups: ["downstairs"] },
          priority: "normal",
          status: "sent",
          announcementId: ANN_ID,
        });
        if (includeArgs) {
          const generic = rows.find((row) => row.event === "mcp.tool" && row.args);
          expect(generic.args.text).toBe(`[omitted: ${SECRET_TEXT.length} characters]`);
        } else {
          expect(rows.filter((row) => row.event === "mcp.tool").every((row) => row.args === undefined)).toBe(true);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
