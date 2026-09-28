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
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  DeviceAuthorization,
  ThalovantAdmissionFailedError,
  ThalovantAdmissionTimeoutError,
  ThalovantAlreadyLinkedError,
  ThalovantApiError,
  ThalovantApiUnreachableError,
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
  response: { status: number; content_type: string; body: string; headers?: Record<string, string> };
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
    // The case's own headers too: a 429 carries Retry-After or RateLimit-Reset.
    response.writeHead(exchange.response.status, {
      ...(exchange.response.headers ?? {}),
      ...(answer.length ? { "Content-Type": exchange.response.content_type, "Content-Length": String(answer.length) } : {}),
    });
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

/**
 * The API the tools' servers are pointed at, for the whole file. The SDK path
 * swaps in a server of its own for each case, so a request an earlier case
 * gave up on at its deadline can never take a later case's answer.
 */
let api = new ScriptedApi();

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

/** A failure, with the api-errors fields when the API answered one. */
function deviceError(error: ThalovantApiError): Json {
  return error.statusCode === undefined ? { outcome: "error", status: null } : { outcome: "error", ...apiFields(error) };
}

async function sdkDevice(call: Json): Promise<Json[]> {
  // Only the approver's read is signed in; a device signing in has no token yet.
  const plane = new ThalovantControlPlane(api.url, call.op === "describe" ? { accessToken: "synthetic-token" } : {});
  if (call.op === "describe") {
    try {
      const request = await plane.describeDeviceLogin(call.user_code as string);
      return [{
        outcome: "described",
        scopes: [...request.scopes],
        client_name: request.clientName,
        client_id: request.clientId,
        client_verified: request.clientVerified,
        device_name: request.deviceName,
      }];
    } catch (error) {
      assert.ok(error instanceof ThalovantApiError, String(error));
      excluded(`${error.message} ${String(error)}`, DEVICE.message_excludes);
      return [deviceError(error)];
    }
  }
  if (call.op === "begin") {
    try {
      const grant = await plane.beginDeviceLogin({
        scopes: call.scopes as string[] | undefined,
        clientName: call.client_name as string | undefined,
        clientId: call.client_id as string | null | undefined,
      });
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
      return [deviceError(error)];
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
      else produced.push(deviceError(error));
    }
  }
  if (call.op === "revoke") {
    await plane.revokeApiToken();
    assert.equal(plane.accessToken, undefined);
    // Idempotent: revoking again sends nothing and succeeds.
    await plane.revokeApiToken();
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

/** Admission as the reference records it: polls on a timeout when the case names them, and the bound a wait met. */
function admissionShape(expect: Json, produced: Json, waitedMs: number): Json {
  if (produced.outcome === "timeout" && !("polls" in expect)) delete produced.polls;
  if ("waited_at_least_ms" in expect) {
    const bound = expect.waited_at_least_ms as number;
    produced.waited_at_least_ms = waitedMs >= bound ? bound : Math.floor(waitedMs);
  }
  return produced;
}

/**
 * A loopback port where the API is out of reach: a listener that resets every
 * connection at once. A port nothing listens on would do on Linux, but
 * Windows takes about 2 s to refuse a connect, the whole budget of the case.
 * Closed after the file.
 */
const resetters: NetServer[] = [];
async function unreachablePort(): Promise<number> {
  const listener = createNetServer((socket) => socket.resetAndDestroy());
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  resetters.push(listener);
  return (listener.address() as AddressInfo).port;
}

afterAll(async () => {
  await Promise.all(resetters.splice(0).map((listener) => new Promise<void>((resolve) => listener.close(() => resolve()))));
});

/** The case's operation with {api_host} and {api_port} filled in. */
function placed(value: unknown): unknown {
  const port = new URL(api.url).port;
  if (typeof value === "string") return value.replaceAll("{api_host}", "127.0.0.1").replaceAll("{api_port}", port);
  if (Array.isArray(value)) return value.map((item) => placed(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, placed(item)]));
  return value;
}

/** A failed admission as the reference records it: the API's status, code and detail when it refused the wait. */
function failedShape(errorCode: unknown, status: unknown, code: unknown, detail: unknown, polls: number): Json {
  const produced: Json = { outcome: "failed", error_code: errorCode ?? null, status: status ?? null };
  if (status !== null && status !== undefined) Object.assign(produced, { code: code ?? null, detail: detail ?? null });
  produced.polls = polls;
  return produced;
}

async function sdkAdmission(call: Json, expect: Json): Promise<Json> {
  const url = call.api === "unreachable" ? `http://127.0.0.1:${await unreachablePort()}` : api.url;
  const plane = new ThalovantControlPlane(url, { accessToken: TOKEN });
  const started = performance.now();
  let produced: Json;
  try {
    await plane.waitForAdmission(placed(call.operation) as Json | null, {
      timeoutMs: call.timeout_ms as number,
      pollIntervalMs: call.poll_interval_ms as number,
    });
    produced = { outcome: "admitted", polls: api.sent.length };
  } catch (error) {
    if (error instanceof ThalovantAdmissionTimeoutError) {
      assert.ok(error instanceof ThalovantConnectionError && error instanceof ThalovantTimeoutError);
      assert.ok(error.message.endsWith("it may still admit it later."), error.message);
      produced = { outcome: "timeout", polls: api.sent.length };
    } else if (error instanceof ThalovantAdmissionFailedError) {
      produced = failedShape(error.errorCode, error.statusCode, error.code, error.detail, api.sent.length);
    } else if (error instanceof ThalovantApiUnreachableError) {
      produced = { outcome: "unreachable", polls: api.sent.length };
    } else if (error instanceof ThalovantAuthError) {
      produced = { outcome: "auth", status: error.statusCode ?? null, polls: api.sent.length };
    } else {
      assert.ok(error instanceof ThalovantApiError, String(error));
      produced = { outcome: "error", polls: api.sent.length };
    }
  }
  return admissionShape(expect, produced, performance.now() - started);
}

describe("the SDK under this server runs the vectors", () => {
  for (const [file, spec, run] of [
    ["device-login-vectors.json", DEVICE, sdkDevice],
    ["connection-kinds-vectors.json", KINDS, sdkKinds],
    ["connection-admission-vectors.json", ADMISSION, sdkAdmission],
  ] as const) {
    for (const one of spec.cases) {
      test(`${file}: ${one.name}`, async () => {
        const shared = api;
        const own = new ScriptedApi();
        await own.start();
        own.use(one.exchanges);
        api = own;
        let produced: unknown;
        try {
          produced = await (run as (call: Json, expect: Json) => Promise<unknown>)(one.call, one.expect as Json);
        } finally {
          api = shared;
          await own.stop();
        }
        // Recorded before the assert: what the SDK produced, not the vector restated.
        record(file, one.name, produced);
        assert.deepEqual(own.mismatches, []);
        if (file === "device-login-vectors.json") assert.equal(own.index, one.exchanges.length, "not every exchange was used");
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

  // Reading a code as its approver sees it has no tool: a model has no
  // approval screen to read. Those cases run through the SDK above.
  for (const one of DEVICE.cases.filter((item) => item.call.op !== "describe")) {
    test(one.name, async () => {
      const call = one.call as { op: string; scopes?: string[]; client_name?: string; client_id?: string | null; times?: number };
      const expect = one.expect as Json[];
      let produced: Json[] = [];
      if (call.op === "begin") {
        api.use(one.exchanges);
        const answer = await tool(client, "thalovant_begin_device_login", {
          scopes: call.scopes,
          clientName: call.client_name,
          clientId: call.client_id ?? undefined,
        });
        excluded(answer.text, DEVICE.message_excludes);
        if (answer.error) {
          // A failure the API explained is error text; the vector says what it must carry.
          assert.equal(expect[0].outcome, "error", answer.text);
          assertSaid(answer.text, expect[0]);
          // Checked above, not recorded: a restated vector is no evidence.
          produced = expect[0].status === null ? [{ outcome: "error", status: statusIn(answer.text) }] : [expect[0]];
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
        if (!answer.error || expect[0].status === null) record("device-login-vectors.json", one.name, produced);
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
          // Idempotent: signing out again answers without a request.
          const sent = api.sent.length;
          const again = await tool(client, "thalovant_revoke_device_login", {});
          assert.equal(again.error, false, again.text);
          assert.equal(again.json!.alreadyRevoked, true);
          assert.equal(api.sent.length, sent);
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
      const call = one.call as { operation: { links: { self: string } } | null; timeout_ms: number; api?: string };
      api.use(one.exchanges);
      // An API out of reach needs a server pointed at a port nothing listens on.
      const using = call.api === "unreachable"
        ? await stdioServer({ THALOVANT_API_URL: `http://127.0.0.1:${await unreachablePort()}`, THALOVANT_API_TOKEN: TOKEN })
        : client;
      const started = performance.now();
      try {
        const operation = placed(call.operation) as { links: { self: string } } | null;
        // The tool's own floors: a second of waiting and half a second between reads.
        const answer = await tool(using, "thalovant_wait_for_admission", {
          ...(operation ? { operationId: operation.links.self } : {}),
          timeoutMs: Math.max(1_000, call.timeout_ms),
          pollIntervalMs: 500,
        });
        const out = answer.json;
        let produced: Json;
        if (!answer.error) {
          produced = out!.outcome === "failed"
            ? failedShape(out!.errorCode, out!.status, out!.code, out!.detail, api.sent.length)
            : { outcome: out!.outcome, polls: api.sent.length };
        } else if (/Sign in again/.test(answer.text)) {
          produced = { outcome: "auth", status: statusIn(answer.text), polls: api.sent.length };
        } else if (/could not be reached/.test(answer.text)) {
          produced = { outcome: "unreachable", polls: api.sent.length };
        } else {
          assert.match(answer.text, /outside the Thalovant API/);
          produced = { outcome: "error", polls: api.sent.length };
        }
        admissionShape(one.expect as Json, produced, performance.now() - started);
        record("connection-admission-vectors.json", one.name, produced);
        assert.deepEqual(api.mismatches, []);
        assert.deepEqual(produced, one.expect);
      } finally {
        if (using !== client) await using.close();
      }
    }, 15_000);
  }
});
