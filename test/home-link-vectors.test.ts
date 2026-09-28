/**
 * The Home Assistant link's control-plane half, against the reference's vectors.
 *
 * `device-login-vectors.json`, `connection-kinds-vectors.json` and
 * `connection-admission-vectors.json` are HTTP exchanges. Each case's answers
 * are served in order by one loopback API that checks every request against
 * the one the case names (method, path, body or body subset, `If-Match`,
 * `Authorization`). Each case runs twice:
 *
 * - through the `@thalovant/sdk` that resolves here, which is what every tool
 *   below calls, recorded before it is asserted; and
 * - through the tools themselves, over stdio against the built server --
 *   `thalovant_begin_device_login`, `thalovant_poll_device_login`,
 *   `thalovant_revoke_device_login`, `thalovant_create_client_identity`,
 *   `thalovant_delete_client` and `thalovant_wait_for_admission`. What a tool
 *   answers is recorded under the same case name, so a tool that produced
 *   anything else than the SDK fails the recorder; a refusal, which a tool
 *   reports as error text, is checked for its status, code and sentence.
 *
 * `home-link` is not applicable here: a tool call holds a hub connection only
 * for its own length, and nothing could answer a hub's request.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  DeviceAuthorization,
  ThalovantAdmissionFailedError,
  ThalovantAdmissionTimeoutError,
  ThalovantAlreadyLinkedError,
  ThalovantApiError,
  ThalovantAuthError,
  ThalovantConnectionError,
  ThalovantControlPlane,
  ThalovantDeviceLoginDeniedError,
  ThalovantDeviceLoginExpiredError,
  ThalovantDeviceLoginPendingError,
  ThalovantPlanError,
  ThalovantTimeoutError,
  ThalovantUnsupportedConnectionTypeError,
} from "@thalovant/sdk";
import { afterAll, beforeAll, describe, test } from "vitest";

import { record } from "./conformance-record.js";

type Json = Record<string, unknown>;

interface Exchange {
  request: { method: string; path: string; json?: unknown; json_subset?: unknown; if_match?: string; authorization?: string };
  response: { status: number; content_type: string; body: string };
  repeat?: boolean;
}

interface HttpCase {
  name: string;
  call: Json;
  exchanges: Exchange[];
  expect: unknown;
}

const vectors = (name: string) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));

const DEVICE: { cases: HttpCase[]; message_excludes: string[] } = vectors("device-login-vectors.json");
const KINDS: { cases: HttpCase[]; message_excludes: string[] } = vectors("connection-kinds-vectors.json");
const ADMISSION: { cases: HttpCase[] } = vectors("connection-admission-vectors.json");

const TOKEN = "tvpat_home-link-vectors";

/** One loopback API for the whole file; each case swaps in its own exchanges. */
class ScriptedApi {
  sent: string[] = [];
  mismatches: string[] = [];
  index = 0;
  url = "";
  private exchanges: Exchange[] = [];
  private server?: Server;

  /** Whether every exchange the case scripted was asked for. */
  get allUsed(): boolean {
    return this.index === this.exchanges.length;
  }

  use(exchanges: Exchange[]): void {
    this.exchanges = exchanges;
    this.sent = [];
    this.mismatches = [];
    this.index = 0;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      this.server?.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const ifMatch = request.headers["if-match"];
    this.sent.push(`${request.method} ${path}${ifMatch ? ` If-Match=${ifMatch}` : ""}`);
    const exchange = this.exchanges[this.index];
    if (!exchange) {
      this.mismatches.push(`unexpected ${request.method} ${path}`);
      response.writeHead(599).end("{}");
      return;
    }
    if (!exchange.repeat) this.index += 1;
    const expected = exchange.request;
    if (request.method !== expected.method || path !== expected.path) {
      this.mismatches.push(`${request.method} ${path} != ${expected.method} ${expected.path}`);
    }
    const body: unknown = raw ? JSON.parse(raw) : null;
    if ("json" in expected && !same(body, expected.json)) this.mismatches.push(`body ${raw} != ${JSON.stringify(expected.json)}`);
    if ("json_subset" in expected && !contains(body, expected.json_subset)) this.mismatches.push(`body lacks ${JSON.stringify(expected.json_subset)}`);
    if ("if_match" in expected && ifMatch !== expected.if_match) this.mismatches.push(`If-Match ${String(ifMatch)} != ${expected.if_match}`);
    if ("authorization" in expected && request.headers.authorization !== expected.authorization) this.mismatches.push("wrong Authorization header");
    const answer = Buffer.from(exchange.response.body, "utf8");
    response.writeHead(
      exchange.response.status,
      answer.length ? { "Content-Type": exchange.response.content_type, "Content-Length": String(answer.length) } : {},
    );
    response.end(answer);
  }
}

function same(left: unknown, right: unknown): boolean {
  try {
    assert.deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function contains(value: unknown, subset: unknown): boolean {
  if (subset && typeof subset === "object" && !Array.isArray(subset)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(subset).every(([key, item]) => key in value && contains((value as Json)[key], item));
  }
  return same(value, subset);
}

const api = new ScriptedApi();

beforeAll(async () => {
  await api.start();
});

afterAll(async () => {
  await api.stop();
});

function apiFields(error: ThalovantApiError): Json {
  return { status: error.statusCode ?? null, code: error.code ?? null, detail: error.detail ?? null };
}

function excluded(text: string, excludes: readonly string[]): void {
  for (const secret of excludes) assert.ok(!text.includes(secret), `${JSON.stringify(secret)} reached ${JSON.stringify(text)}`);
}

// -- through the SDK under this server --------------------------------------------

async function sdkDevice(call: Json): Promise<Json[]> {
  const plane = new ThalovantControlPlane(api.url);
  if (call.op === "begin") {
    try {
      const grant = await plane.beginDeviceLogin({ scopes: call.scopes as string[] | undefined, clientName: call.client_name as string | undefined });
      return [{
        outcome: "started",
        user_code: grant.userCode,
        verification_uri: grant.verificationUri,
        verification_uri_complete: grant.verificationUriComplete,
        interval: grant.interval,
        expires_in: grant.expiresIn,
      }];
    } catch (error) {
      assert.ok(error instanceof ThalovantApiError, String(error));
      excluded(`${error.message} ${String(error)}`, DEVICE.message_excludes);
      return [{ outcome: "error", status: error.statusCode ?? null }];
    }
  }
  const given = call.authorization as { device_code: string; interval: number };
  const authorization = DeviceAuthorization.fromGrant({
    device_code: given.device_code,
    user_code: "WDJB-MJHT",
    verification_uri: "https://thalovant.com/activate",
    interval: given.interval,
    expires_in: 900,
  });
  const produced: Json[] = [];
  for (let poll = 0; poll < ((call.times as number | undefined) ?? 1); poll += 1) {
    try {
      const token = await plane.pollDeviceLogin(authorization);
      assert.equal(plane.accessToken, token.accessToken);
      produced.push({ outcome: "approved", token_type: token.tokenType, scopes: [...token.scopes], expires_at: token.expiresAt, token_id: token.tokenId });
    } catch (error) {
      assert.ok(error instanceof ThalovantApiError, String(error));
      excluded(`${error.message} ${String(error)}`, DEVICE.message_excludes);
      if (error instanceof ThalovantDeviceLoginPendingError) produced.push({ outcome: "pending", interval: error.interval });
      else if (error instanceof ThalovantDeviceLoginExpiredError) produced.push({ outcome: "expired", status: error.statusCode ?? null });
      else if (error instanceof ThalovantDeviceLoginDeniedError) produced.push({ outcome: "denied", status: error.statusCode ?? null });
      else produced.push(error.statusCode === undefined ? { outcome: "error", status: null } : { outcome: "error", ...apiFields(error) });
    }
  }
  if (call.op === "revoke") {
    await plane.revokeApiToken();
    assert.equal(plane.accessToken, undefined);
    return [{ outcome: "revoked" }];
  }
  return produced;
}

function kindOutcome(error: ThalovantApiError): string {
  if (error instanceof ThalovantPlanError) return "plan";
  if (error instanceof ThalovantAlreadyLinkedError) return "already_linked";
  if (error instanceof ThalovantAuthError) return "auth";
  return "error";
}

async function sdkKinds(call: Json): Promise<Json> {
  const plane = new ThalovantControlPlane(api.url, { accessToken: TOKEN });
  let produced: Json;
  if (call.op === "create") {
    try {
      const result = await plane.createClientIdentity(call.hub as Json, { name: call.name as string, connectionType: call.connection_type as string });
      produced = { outcome: "created", client_id: result.clientId ?? null, connection_type: result.connectionType ?? null, operation_id: result.operation?.id ?? null };
    } catch (error) {
      assert.ok(error instanceof ThalovantApiError, String(error));
      excluded(`${error.message} ${String(error)}`, KINDS.message_excludes);
      if (error instanceof ThalovantUnsupportedConnectionTypeError) {
        produced = error.statusCode !== undefined
          ? { outcome: "unsupported", ...apiFields(error) }
          : { outcome: "unsupported", deleted: api.sent.some((line) => line.startsWith("DELETE ")) };
      } else {
        produced = { outcome: kindOutcome(error), ...apiFields(error) };
        if (error instanceof ThalovantAlreadyLinkedError) produced.client_id = error.clientId ?? null;
      }
    }
  } else {
    try {
      await plane.deleteClient(call.client_id as string, { etag: call.etag as string | null });
      produced = { outcome: "deleted" };
    } catch (error) {
      assert.ok(error instanceof ThalovantApiError, String(error));
      produced = { outcome: kindOutcome(error), ...apiFields(error) };
    }
  }
  produced.requests = [...api.sent];
  return produced;
}

async function sdkAdmission(call: Json): Promise<Json> {
  const plane = new ThalovantControlPlane(api.url, { accessToken: TOKEN });
  try {
    await plane.waitForAdmission(call.operation as Json | null, {
      timeoutMs: (call.timeout_seconds as number) * 1000,
      pollIntervalMs: (call.poll_interval_seconds as number) * 1000,
    });
    return { outcome: "admitted", polls: api.sent.length };
  } catch (error) {
    if (error instanceof ThalovantAdmissionTimeoutError) {
      assert.ok(error instanceof ThalovantConnectionError && error instanceof ThalovantTimeoutError);
      return { outcome: "timeout" };
    }
    if (error instanceof ThalovantAdmissionFailedError) return { outcome: "failed", error_code: error.errorCode ?? null, polls: api.sent.length };
    assert.ok(error instanceof ThalovantApiError, String(error));
    return { outcome: "error", polls: api.sent.length };
  }
}

describe("the SDK under this server runs the vectors", () => {
  for (const [file, spec, run] of [
    ["device-login-vectors.json", DEVICE, sdkDevice],
    ["connection-kinds-vectors.json", KINDS, sdkKinds],
    ["connection-admission-vectors.json", ADMISSION, sdkAdmission],
  ] as const) {
    for (const one of spec.cases) {
      test(`${file}: ${one.name}`, async () => {
        api.use(one.exchanges);
        const produced = await (run as (call: Json) => Promise<unknown>)(one.call);
        // Recorded before the assert: what the SDK produced, not the vector restated.
        record(file, one.name, produced);
        assert.deepEqual(api.mismatches, []);
        if (file === "device-login-vectors.json") assert.equal(api.index, one.exchanges.length, "not every exchange was used");
        assert.deepEqual(produced, one.expect);
      }, 15_000);
    }
  }
});

// -- through the tools ------------------------------------------------------------

async function stdioServer(env: Record<string, string>): Promise<Client> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("THALOVANT_") || key.startsWith("MCP_")) continue;
    inherited[key] = value;
  }
  const client = new Client({ name: "thalovant-mcp-home-link-vectors", version: "0.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...inherited, ...env } }));
  return client;
}

async function tool(client: Client, name: string, args: Json): Promise<{ error: boolean; text: string; json?: Json }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");
  if (result.isError) return { error: true, text };
  return { error: false, text, json: JSON.parse(text) as Json };
}

/** The status a tool error names, or null when the API never answered with one. */
function statusIn(text: string): number | null {
  const found = /HTTP (\d{3})\b/.exec(text);
  return found ? Number(found[1]) : null;
}

/** A refusal's status, code and whole sentence, in the error text a tool returned. */
function assertSaid(text: string, expect: Json): void {
  assert.equal(statusIn(text), expect.status ?? null, text);
  if (expect.code) assert.ok(text.includes(`(${expect.code as string})`) || text.includes(`code: ${expect.code as string}`), text);
  if (expect.detail) assert.ok(text.replace(/\s+/g, " ").includes(expect.detail as string), text);
}

describe("the device sign-in tools", () => {
  let client: Client;
  beforeAll(async () => {
    client = await stdioServer({ THALOVANT_API_URL: api.url });
  }, 15_000);
  afterAll(async () => {
    await client?.close();
  });

  /** Every poll or revoke case starts with a begin the tools need and the SDK path did not. */
  const begun = (one: HttpCase): Exchange[] => {
    const given = one.call.authorization as { device_code: string; interval: number };
    const grant = { device_code: given.device_code, user_code: "WDJB-MJHT", verification_uri: "https://thalovant.com/activate", expires_in: 900, interval: given.interval };
    return [
      { request: { method: "POST", path: "/v1/auth/device/authorize" }, response: { status: 200, content_type: "application/json", body: JSON.stringify(grant) } },
      ...one.exchanges,
    ];
  };

  for (const one of DEVICE.cases) {
    test(one.name, async () => {
      const call = one.call as { op: string; scopes?: string[]; client_name?: string; times?: number };
      const expect = one.expect as Json[];
      let produced: Json[] = [];
      if (call.op === "begin") {
        api.use(one.exchanges);
        const answer = await tool(client, "thalovant_begin_device_login", { scopes: call.scopes, clientName: call.client_name });
        excluded(answer.text, DEVICE.message_excludes);
        if (answer.error) {
          produced = [{ outcome: "error", status: statusIn(answer.text) }];
        } else {
          const out = answer.json!;
          assert.equal(typeof out.loginId, "string");
          produced = [{
            outcome: "started",
            user_code: out.userCode,
            verification_uri: out.verificationUri,
            verification_uri_complete: out.verificationUriComplete,
            interval: out.interval,
            expires_in: out.expiresIn,
          }];
        }
        record("device-login-vectors.json", one.name, produced);
        assert.deepEqual(produced, expect);
      } else {
        api.use(begun(one));
        const started = await tool(client, "thalovant_begin_device_login", {});
        assert.equal(started.error, false, started.text);
        const loginId = started.json!.loginId as string;
        for (let poll = 0; poll < (call.times ?? 1); poll += 1) {
          const answer = await tool(client, "thalovant_poll_device_login", { loginId });
          excluded(answer.text, DEVICE.message_excludes);
          const want = expect[poll];
          if (answer.error) {
            // A failure the API explained is error text; the vector says what it must carry.
            assert.equal(want.outcome, "error", answer.text);
            assertSaid(answer.text, want);
            produced.push(want);
            continue;
          }
          const out = answer.json!;
          produced.push(
            out.outcome === "pending" ? { outcome: "pending", interval: out.interval }
            : out.outcome === "approved" ? { outcome: "approved", token_type: out.tokenType, scopes: out.scopes, expires_at: out.expiresAt, token_id: out.tokenId }
            : { outcome: out.outcome, status: out.status },
          );
        }
        if (call.op === "revoke") {
          const answer = await tool(client, "thalovant_revoke_device_login", {});
          assert.equal(answer.error, false, answer.text);
          assert.equal(answer.json!.revoked, true);
          produced = [{ outcome: "revoked" }];
          // Signed out: nothing is left to revoke.
          assert.equal((await tool(client, "thalovant_revoke_device_login", {})).error, true);
        }
        if (!produced.some((item) => item.outcome === "error")) record("device-login-vectors.json", one.name, produced);
        assert.deepEqual(produced, expect);
      }
      assert.deepEqual(api.mismatches, []);
      assert.ok(api.allUsed, "not every exchange was used");
    }, 15_000);
  }
});

describe("the connection tools", () => {
  let client: Client;
  beforeAll(async () => {
    client = await stdioServer({ THALOVANT_API_URL: api.url, THALOVANT_API_TOKEN: TOKEN, THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "true" });
  }, 15_000);
  afterAll(async () => {
    await client?.close();
  });

  for (const one of KINDS.cases) {
    test(one.name, async () => {
      const call = one.call as { op: string; hub?: Json; name?: string; connection_type?: string; client_id?: string; etag?: string | null };
      const expect = one.expect as Json;
      let answer: Awaited<ReturnType<typeof tool>>;
      if (call.op === "create") {
        // The tool takes the hub's id and reads the hub first, which the SDK path was handed.
        const hub = call.hub!;
        api.use([
          { request: { method: "GET", path: `/v1/hubs/${hub.id as string}` }, response: { status: 200, content_type: "application/json", body: JSON.stringify(hub) } },
          ...one.exchanges,
        ]);
        answer = await tool(client, "thalovant_create_client_identity", { hubId: hub.id, name: call.name, connectionType: call.connection_type });
      } else {
        api.use(one.exchanges);
        answer = await tool(client, "thalovant_delete_client", { clientId: call.client_id, ...(call.etag ? { etag: call.etag } : {}) });
      }
      excluded(answer.text, KINDS.message_excludes);
      const requests = api.sent.filter((line) => !line.startsWith("GET /v1/hubs/"));
      assert.deepEqual(api.mismatches, []);
      assert.deepEqual(requests, expect.requests);
      if (answer.error) {
        assert.notEqual(expect.outcome, "created");
        assert.notEqual(expect.outcome, "deleted");
        assertSaid(answer.text, expect);
        if (expect.client_id) assert.ok(answer.text.includes(expect.client_id as string), answer.text);
        // Each kind of refusal says what to do about it.
        const hint = {
          unsupported: /does not (know|support) the (connection type|kind)/,
          plan: /plan/,
          already_linked: /one Home Assistant connection/,
          auth: /Sign in again/,
          error: /./,
        }[expect.outcome as string]!;
        assert.match(answer.text, hint);
        return;
      }
      const out = answer.json!;
      const produced: Json = call.op === "create"
        ? { outcome: "created", client_id: out.clientId, connection_type: out.connectionType, operation_id: out.operationId, requests }
        : { outcome: "deleted", requests };
      record("connection-kinds-vectors.json", one.name, produced);
      assert.deepEqual(produced, expect);
      // The secret identity never reaches the model.
      assert.ok(!answer.text.includes("synthetic-hub-password"));
    }, 15_000);
  }
});

describe("the admission tool", () => {
  let client: Client;
  beforeAll(async () => {
    client = await stdioServer({ THALOVANT_API_URL: api.url, THALOVANT_API_TOKEN: TOKEN });
  }, 15_000);
  afterAll(async () => {
    await client?.close();
  });

  for (const one of ADMISSION.cases) {
    test(one.name, async () => {
      const call = one.call as { operation: { links: { self: string } } | null; timeout_seconds: number };
      api.use(one.exchanges);
      // The tool's own floors: a second of waiting and half a second between reads.
      const answer = await tool(client, "thalovant_wait_for_admission", {
        ...(call.operation ? { operationId: call.operation.links.self } : {}),
        timeoutMs: Math.max(1_000, call.timeout_seconds * 1000),
        pollIntervalMs: 500,
      });
      const out = answer.json;
      const produced: Json = answer.error ? { outcome: "error", polls: api.sent.length }
        : out!.outcome === "timeout" ? { outcome: "timeout" }
        : out!.outcome === "failed" ? { outcome: "failed", error_code: out!.errorCode, polls: api.sent.length }
        : { outcome: out!.outcome, polls: api.sent.length };
      record("connection-admission-vectors.json", one.name, produced);
      assert.deepEqual(api.mismatches, []);
      assert.deepEqual(produced, one.expect);
      if (answer.error) assert.match(answer.text, /outside the Thalovant API/);
    }, 15_000);
  }
});
