/**
 * The Home Assistant link tools beyond the shared vectors: where a device
 * sign-in's secrets live and who may use them, which origin a sign-in may
 * reach, which tools each mode registers, and that waiting for admission stops
 * when the caller cancels.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DeviceAuthorization, ThalovantControlPlane } from "@thalovant/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceLogins } from "../src/device-login.js";

const MINTED = "tvpat_minted_by_a_device_login";
const DEVICE_CODE = "dc-never-shown-to-a-model";

interface Seen {
  method: string;
  path: string;
  authorization?: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A control plane that approves the second poll and records every request. */
async function controlPlane(options: { approveAfter?: number } = {}): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  let polls = 0;
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      seen.push({ method: request.method ?? "", path, authorization: request.headers.authorization });
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === "/v1/auth/device/authorize") {
        return json(200, { device_code: DEVICE_CODE, user_code: "ABCD-EFGH", verification_uri: "https://dash.example.invalid/activate", interval: 1, expires_in: 600 });
      }
      if (path === "/v1/auth/device/token") {
        polls += 1;
        return polls > (options.approveAfter ?? 1)
          ? json(200, { access_token: MINTED, token_type: "bearer", scopes: ["hubs:read", "clients:read", "clients:write"], expires_at: "2027-09-27T10:00:00Z", token_id: "t-1" })
          : json(400, { error: "authorization_pending" });
      }
      if (path.startsWith("/v1/auth/api-tokens/")) {
        response.writeHead(204);
        return response.end();
      }
      if (path.startsWith("/v1/hubs/")) return json(200, { id: "hub-1", name: "Kitchen hub" });
      if (path.startsWith("/v1/operations/")) {
        return json(200, { id: "op-1", status: "committed", links: { self: "/v1/operations/op-1" } });
      }
      return json(404, { detail: "Not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function stdio(env: Record<string, string>): Promise<Client> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("THALOVANT_") || key.startsWith("MCP_")) continue;
    inherited[key] = value;
  }
  const client = new Client({ name: "thalovant-mcp-device-login", version: "0.0.0" }, { capabilities: {} });
  cleanups.push(() => client.close());
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...inherited, ...env } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  const result = await client.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined);
  const text = (result.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");
  return { error: Boolean(result.isError), text, json: result.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
}

async function names(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name);
}

describe("device sign-ins held by the server", () => {
  const grant = () => DeviceAuthorization.fromGrant({
    device_code: DEVICE_CODE,
    user_code: "ABCD-EFGH",
    verification_uri: "https://dash.example.invalid/activate",
    expires_in: 60,
  });

  it("belong to the principal that started them, and expire", () => {
    let now = 1_000;
    const logins = new DeviceLogins(() => now);
    const api = new ThalovantControlPlane("https://api.example.invalid");
    const id = logins.start("alice", api, grant());
    expect(logins.find(id, "alice")).toBeDefined();
    expect(logins.find(id, "bob")).toBeUndefined();
    expect(logins.find("not-an-id", "alice")).toBeUndefined();
    now += 60_000;
    expect(logins.find(id, "alice")).toBeUndefined();
  });

  it("keep a token per principal and per origin, until sign-out", () => {
    const logins = new DeviceLogins();
    const api = new ThalovantControlPlane("https://api.example.invalid", { accessToken: MINTED });
    logins.approve("alice", api);
    expect(logins.signedInOn("alice", "https://api.example.invalid")?.api).toBe(api);
    expect(logins.signedInOn("alice", "https://elsewhere.example.invalid")).toBeUndefined();
    expect(logins.signedInOn("bob", "https://api.example.invalid")).toBeUndefined();
    logins.signOut("alice");
    expect(logins.signedInAs("alice")).toBeUndefined();
  });

  it("hold a few sign-ins per principal, and one principal cannot drop another's", () => {
    const logins = new DeviceLogins();
    const api = new ThalovantControlPlane("https://api.example.invalid");
    const alices = logins.start("alice", api, grant());
    const first = logins.start("bob", api, grant());
    const later = [1, 2, 3].map(() => logins.start("bob", api, grant()));
    expect(logins.find(first, "bob")).toBeDefined();
    logins.start("bob", api, grant());
    // Bob's fifth drops Bob's first, and only it.
    expect(logins.find(first, "bob")).toBeUndefined();
    for (const id of later) expect(logins.find(id, "bob")).toBeDefined();
    for (let started = 0; started < 100; started += 1) logins.start("bob", api, grant());
    expect(logins.find(alices, "alice")).toBeDefined();
  });

  it("refuse a new sign-in once the server holds as many as it will", () => {
    const logins = new DeviceLogins();
    const api = new ThalovantControlPlane("https://api.example.invalid");
    for (let principal = 0; principal < 64; principal += 1) {
      for (let started = 0; started < 4; started += 1) logins.start(`p${principal}`, api, grant());
    }
    expect(() => logins.start("latecomer", api, grant())).toThrow(/Too many device sign-ins/);
  });
});

describe("the sign-in tools", () => {
  it("sign in, lend the token to every control-plane tool, and never show it or the device code", async () => {
    const api = await controlPlane();
    const client = await stdio({ THALOVANT_API_URL: api.url });
    // Nothing configured: an authenticated tool says how to get a credential.
    expect((await call(client, "thalovant_get_hub", { hubId: "hub-1" })).error).toBe(true);

    const started = await call(client, "thalovant_begin_device_login", { scopes: ["hubs:read", "clients:read", "clients:write"], clientName: "Home Assistant" });
    expect(started.error).toBe(false);
    expect(started.json).toMatchObject({ userCode: "ABCD-EFGH", verificationUri: "https://dash.example.invalid/activate", interval: 1, expiresIn: 600 });
    const loginId = started.json!.loginId as string;

    expect((await call(client, "thalovant_poll_device_login", { loginId })).json).toEqual({ outcome: "pending", interval: 1 });
    const approved = await call(client, "thalovant_poll_device_login", { loginId });
    expect(approved.json).toMatchObject({ outcome: "approved", tokenId: "t-1", scopes: ["hubs:read", "clients:read", "clients:write"] });
    // A sign-in that ended cannot be polled again.
    expect((await call(client, "thalovant_poll_device_login", { loginId })).error).toBe(true);

    const hub = await call(client, "thalovant_get_hub", { hubId: "hub-1" });
    expect(hub.error).toBe(false);
    expect(api.seen.find((request) => request.path === "/v1/hubs/hub-1")?.authorization).toBe(`Bearer ${MINTED}`);
    expect((await call(client, "thalovant_config_status")).json).toMatchObject({ deviceLoginSignedIn: true });

    const revoked = await call(client, "thalovant_revoke_device_login");
    expect(revoked.json).toEqual({ revoked: true, tokenId: "t-1" });
    const revoke = api.seen.find((request) => request.method === "DELETE");
    expect(revoke).toMatchObject({ path: "/v1/auth/api-tokens/t-1", authorization: `Bearer ${MINTED}` });
    expect((await call(client, "thalovant_get_hub", { hubId: "hub-1" })).error).toBe(true);
    expect((await call(client, "thalovant_config_status")).json).toMatchObject({ deviceLoginSignedIn: false });

    for (const answer of [started, approved, revoked, hub]) {
      expect(answer.text).not.toContain(MINTED);
      expect(answer.text).not.toContain(DEVICE_CODE);
    }
    // The token and code never went anywhere but the configured API.
    expect(api.seen.every((request) => !request.path.includes(DEVICE_CODE))).toBe(true);
  }, 30_000);

  it("reach only the configured API origin", async () => {
    const api = await controlPlane();
    const elsewhere = await controlPlane();
    const client = await stdio({ THALOVANT_API_URL: api.url });
    const refused = await call(client, "thalovant_begin_device_login", { apiUrl: elsewhere.url });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("configured Thalovant API origin");
    expect(elsewhere.seen).toHaveLength(0);
    // The same origin, spelled with a path, is the configured one.
    expect((await call(client, "thalovant_begin_device_login", { apiUrl: `${api.url}/v1` })).error).toBe(false);
  }, 15_000);

  it("leave a configured token in charge", async () => {
    const api = await controlPlane({ approveAfter: 0 });
    const client = await stdio({ THALOVANT_API_URL: api.url, THALOVANT_API_TOKEN: "tvpat_configured" });
    const started = await call(client, "thalovant_begin_device_login");
    expect((await call(client, "thalovant_poll_device_login", { loginId: started.json!.loginId as string })).json).toMatchObject({ outcome: "approved" });
    await call(client, "thalovant_get_hub", { hubId: "hub-1" });
    expect(api.seen.find((request) => request.path === "/v1/hubs/hub-1")?.authorization).toBe("Bearer tvpat_configured");
  }, 15_000);

  it("refuse a sign-out with nothing signed in, and an unknown sign-in", async () => {
    const api = await controlPlane();
    const client = await stdio({ THALOVANT_API_URL: api.url });
    expect((await call(client, "thalovant_revoke_device_login")).text).toContain("has not signed in");
    expect((await call(client, "thalovant_poll_device_login", { loginId: "0b9e7c1a-2f44-4d5e-8a3b-6c1d2e9f7a50" })).text).toContain("No device sign-in in progress");
    expect(api.seen).toHaveLength(0);
  }, 15_000);
});

describe("registration", () => {
  it("offers the admission wait in read-only mode and nothing that signs in or deletes", async () => {
    const readOnly = await names(await stdio({ THALOVANT_API_TOKEN: "tvpat_x", THALOVANT_MCP_READONLY: "1" }));
    expect(readOnly).toContain("thalovant_wait_for_admission");
    for (const name of ["thalovant_begin_device_login", "thalovant_poll_device_login", "thalovant_revoke_device_login", "thalovant_delete_client"]) {
      expect(readOnly).not.toContain(name);
    }
    const byDefault = await names(await stdio({ THALOVANT_API_TOKEN: "tvpat_x" }));
    expect(byDefault).toEqual(expect.arrayContaining(["thalovant_begin_device_login", "thalovant_poll_device_login", "thalovant_revoke_device_login", "thalovant_wait_for_admission"]));
    expect(byDefault).not.toContain("thalovant_delete_client");
  }, 30_000);

  it("refuses a connection type that is not a kind's name before any request", async () => {
    const api = await controlPlane();
    const client = await stdio({ THALOVANT_API_URL: api.url, THALOVANT_API_TOKEN: "tvpat_x" });
    const answer = await call(client, "thalovant_create_client_identity", { hubId: "hub-1", name: "HA", connectionType: "Home Assistant" });
    expect(answer.error).toBe(true);
    expect(api.seen).toHaveLength(0);
  }, 15_000);
});

describe("waiting for admission", () => {
  it("stops reading the operation when the caller cancels", async () => {
    const api = await controlPlane();
    const client = await stdio({ THALOVANT_API_URL: api.url, THALOVANT_API_TOKEN: "tvpat_x" });
    const controller = new AbortController();
    const waiting = call(client, "thalovant_wait_for_admission", { operationId: "op-1", timeoutMs: 60_000, pollIntervalMs: 500 }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 700));
    controller.abort();
    await assert.rejects(waiting);
    const reads = api.seen.length;
    expect(reads).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(api.seen).toHaveLength(reads);
  }, 15_000);

  it("reports a timeout as an outcome to wait on again, not as a failure", async () => {
    const api = await controlPlane();
    const client = await stdio({ THALOVANT_API_URL: api.url, THALOVANT_API_TOKEN: "tvpat_x" });
    const answer = await call(client, "thalovant_wait_for_admission", { operationId: "op-1", timeoutMs: 1_000, pollIntervalMs: 500 });
    expect(answer.error).toBe(false);
    expect(answer.json).toMatchObject({ outcome: "timeout" });
    expect(answer.json!.next).toContain("again");
  }, 15_000);
});
