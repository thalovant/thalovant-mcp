/**
 * Browser sign-in beyond the shared vectors: where a sign-in in progress
 * lives and who may read it, what the server opens, that the SDK's printed
 * prompt never reaches the stdio protocol stream, that a hosted (Streamable
 * HTTP) server signs in with a device login exactly as before, and that a
 * browser sign-in's token is used and revoked like a device sign-in's.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  ThalovantApiError,
  ThalovantControlPlane,
  ThalovantDeviceLoginDeniedError,
  ThalovantDeviceLoginExpiredError,
} from "@thalovant/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserLogins, SignInWatch, browserCommand, defaultDeviceName, outcomeOf } from "../src/browser-login.js";
import { BROWSER, BrowserShims, http, machineEnv, pollUntilEnded, refused, Signing, sleep, stdioServer, tool } from "./browser-login-harness.js";

const MINTED = "tvpat_minted_by_a_browser_sign_in";
const DEVICE_MINTED = "tvpat_minted_by_a_device_sign_in";
const CODE = "nc_code_never_shown_to_a_model";
const DEVICE_CODE = "dc-never-shown-to-a-model";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Seen {
  method: string;
  path: string;
  authorization?: string;
}

/** A control plane offering browser sign-in (unless `browser: false`) and device login, recording every request. */
async function controlPlane(options: { browser?: boolean } = {}): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      seen.push({ method: request.method ?? "", path, authorization: request.headers.authorization });
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === "/v1/auth/native/config") {
        if (options.browser === false) return json(404, { detail: "Not Found" });
        return json(200, {
          authorization_endpoint: "https://dash.example.invalid/authorize",
          token_endpoint: "/v1/auth/native/token",
          device_authorization_endpoint: "/v1/auth/device/authorize",
          sdk_client_id: "thalovant-sdk",
          loopback_redirect_uri: "http://127.0.0.1:{port}/callback",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (path === "/v1/auth/native/token") {
        return json(200, { access_token: MINTED, token_type: "bearer", scopes: ["hubs:read", "clients:write"], expires_at: "2027-11-08T12:00:00Z", token_id: "browser-token-1" });
      }
      if (path === "/v1/auth/device/authorize") {
        return json(200, {
          device_code: DEVICE_CODE,
          user_code: "ABCD-EFGH",
          verification_uri: "https://dash.example.invalid/activate",
          verification_uri_complete: "https://dash.example.invalid/activate?user_code=ABCD-EFGH",
          interval: 0,
          expires_in: 600,
        });
      }
      if (path === "/v1/auth/device/token") {
        return json(200, { access_token: DEVICE_MINTED, token_type: "bearer", scopes: ["hubs:read"], expires_at: "2027-11-08T12:00:00Z", token_id: "device-token-1" });
      }
      if (path.startsWith("/v1/auth/api-tokens/")) {
        response.writeHead(204);
        return response.end();
      }
      if (path.startsWith("/v1/hubs/")) return json(200, { id: "hub-1", name: "Kitchen hub" });
      return json(404, { detail: "Not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function shims(): BrowserShims {
  const made = new BrowserShims();
  cleanups.push(() => made.remove());
  return made;
}

/** The consent page answered approved, as the person's browser would. */
async function approve(url: string): Promise<void> {
  const signing = new Signing(url);
  const answer = await http(signing.port, "GET", `/callback?code=${CODE}&state=${signing.state}`);
  expect(answer.status).toBe(200);
  expect(answer.page).toBe("signed_in");
}

// -- the store ---------------------------------------------------------------------------

/** A sign-in the test drives by hand: shown (or not), then settled. */
function manual() {
  const watch = new SignInWatch(() => undefined);
  let settle!: { resolve: (token: Record<string, unknown>) => void; reject: (error: unknown) => void };
  let stopped: AbortSignal | undefined;
  const signIn = (signal: AbortSignal) => {
    stopped = signal;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  return { watch, signIn, settle: () => settle, signal: () => stopped };
}

describe("sign-ins held by the server", () => {
  const api = new ThalovantControlPlane("https://api.example.invalid");

  it("answer once the person has something to open, and belong to the principal that started them", async () => {
    const approved: string[] = [];
    const logins = new BrowserLogins((principal) => void approved.push(principal));
    const one = manual();
    const starting = logins.start("alice", api, one.watch, one.signIn);
    one.watch.openUrl("https://dash.example.invalid/authorize?state=s");
    const { loginId, shown } = await starting;
    expect(shown).toEqual({ method: "browser", authorizationUrl: "https://dash.example.invalid/authorize?state=s" });
    expect(logins.poll(loginId, "bob")).toBeNull();
    expect(logins.poll(loginId, "alice")).toEqual({ shown, outcome: undefined });
    one.settle().resolve({ access_token: MINTED, token_id: "t-1" });
    await sleep(0);
    // The token is used at once, before anybody polls.
    expect(approved).toEqual(["alice"]);
    expect(logins.poll(loginId, "alice")?.outcome).toEqual({ outcome: "approved", token: { access_token: MINTED, token_id: "t-1" } });
    // Reported once, then forgotten.
    expect(logins.poll(loginId, "alice")).toBeNull();
  });

  it("report a sign-in that ended before anything was shown as the start's own error", async () => {
    const logins = new BrowserLogins(() => undefined);
    const one = manual();
    const starting = logins.start("alice", api, one.watch, one.signIn);
    const refusal = new ThalovantApiError("This Thalovant API does not offer browser sign-in.", { statusCode: 404 });
    one.settle().reject(refusal);
    await expect(starting).rejects.toBe(refusal);
  });

  it("read denied, expired and anything else as their outcomes", () => {
    expect(outcomeOf(new ThalovantDeviceLoginDeniedError("denied"))).toEqual({ outcome: "denied", status: null });
    expect(outcomeOf(new ThalovantDeviceLoginExpiredError("expired"))).toEqual({ outcome: "expired", status: null });
    const failed = new ThalovantApiError("invalid_grant", { statusCode: 400 });
    expect(outcomeOf(failed)).toEqual({ outcome: "error", error: failed });
  });

  it("stop a principal's own oldest to make room, and never another principal's", async () => {
    const logins = new BrowserLogins(() => undefined);
    const started = [];
    for (const principal of ["bob", "alice", "alice", "alice", "alice"]) {
      const one = manual();
      const starting = logins.start(principal, api, one.watch, one.signIn);
      one.watch.openUrl(`https://dash.example.invalid/authorize?n=${started.length}`);
      started.push({ ...(await starting), one, principal });
    }
    // Alice's fifth would be one too many: her first is stopped, its port closed.
    const extra = manual();
    const starting = logins.start("alice", api, extra.watch, extra.signIn);
    extra.watch.openUrl("https://dash.example.invalid/authorize?n=extra");
    await starting;
    expect(started[1]!.one.signal()?.aborted).toBe(true);
    expect(logins.poll(started[1]!.loginId, "alice")).toBeNull();
    for (const kept of [started[0]!, ...started.slice(2)]) {
      expect(kept.one.signal()?.aborted).toBe(false);
      expect(logins.poll(kept.loginId, kept.principal)).not.toBeNull();
    }
  });

  it("stop and forget a sign-in nobody polled once its wait and a grace period are over", async () => {
    let now = 1_000;
    const logins = new BrowserLogins(() => undefined, () => now);
    const one = manual();
    const starting = logins.start("alice", api, one.watch, one.signIn, { timeoutMs: 60_000 });
    one.watch.openUrl("https://dash.example.invalid/authorize");
    const { loginId } = await starting;
    now += 60_000 + 299_000;
    expect(logins.poll(loginId, "alice")).not.toBeNull();
    now += 1_000;
    expect(logins.poll(loginId, "alice")).toBeNull();
    expect(one.signal()?.aborted).toBe(true);
  });

  it("stop a sign-in whose tool call is cancelled before anything was shown", async () => {
    const logins = new BrowserLogins(() => undefined);
    const one = manual();
    const cancel = new AbortController();
    const starting = logins.start("alice", api, one.watch, one.signIn, { signal: cancel.signal });
    cancel.abort();
    expect(one.signal()?.aborted).toBe(true);
    one.settle().reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(starting).rejects.toThrow("aborted");
  });
});

describe("what a sign-in shows", () => {
  it("opens the consent page once, and the first thing shown is the method", () => {
    const opened: string[] = [];
    const watch = new SignInWatch((url) => void opened.push(url));
    watch.openUrl("https://dash.example.invalid/authorize?a=1");
    watch.openUrl("https://dash.example.invalid/authorize?a=2");
    expect(opened).toEqual(["https://dash.example.invalid/authorize?a=1"]);
    expect(watch.current).toEqual({ method: "browser", authorizationUrl: "https://dash.example.invalid/authorize?a=1" });
  });

  it("reads a device login's code from the API's answer, and does not open its page", async () => {
    const opened: string[] = [];
    const grant = { device_code: DEVICE_CODE, user_code: "ABCD-EFGH", verification_uri: "https://dash.example.invalid/activate", verification_uri_complete: "https://dash.example.invalid/activate?user_code=ABCD-EFGH", interval: 5, expires_in: 600 };
    const watch = new SignInWatch((url) => void opened.push(url), async () => new Response(JSON.stringify(grant), { status: 200, headers: { "content-type": "application/json" } }));
    const response = await watch.fetch(new URL("https://api.example.invalid/v1/auth/device/authorize"), { method: "POST" });
    // The SDK still reads the whole answer itself.
    expect(await response.json()).toEqual(grant);
    expect(await watch.shown).toEqual({
      method: "device",
      userCode: "ABCD-EFGH",
      verificationUri: "https://dash.example.invalid/activate",
      verificationUriComplete: "https://dash.example.invalid/activate?user_code=ABCD-EFGH",
      interval: 5,
      expiresIn: 600,
    });
    expect(JSON.stringify(watch.current)).not.toContain(DEVICE_CODE);
    watch.openUrl(grant.verification_uri_complete);
    expect(opened).toEqual([]);
  });

  it("shows nothing for a device answer the SDK would refuse", async () => {
    const grant = { device_code: DEVICE_CODE, user_code: "ABCD-EFGH", verification_uri: "https://someone:secret@dash.example.invalid/activate", expires_in: 600 };
    const watch = new SignInWatch(() => undefined, async () => new Response(JSON.stringify(grant), { status: 200 }));
    await watch.fetch(new URL("https://api.example.invalid/v1/auth/device/authorize"), { method: "POST" });
    expect(watch.current).toBeUndefined();
  });

  it("opens a URL with the platform's own opener, as one argument, and nothing that is not a plain http(s) URL", () => {
    const url = "https://dash.example.invalid/authorize?response_type=code&state=a%20b";
    expect(browserCommand(url, "darwin")).toEqual(["open", ["--", url]]);
    expect(browserCommand(url, "win32")).toEqual(["rundll32.exe", ["url.dll,FileProtocolHandler", url]]);
    expect(browserCommand(url, "linux")).toEqual(["xdg-open", [url]]);
    expect(browserCommand(url, "freebsd")).toEqual(["xdg-open", [url]]);
    for (const refusedUrl of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pw@dash.example.invalid/", "https://dash.example.invalid/a b", "not a url"]) {
      expect(browserCommand(refusedUrl, "linux")).toBeUndefined();
    }
  });

  it("names this server on the consent page, cut to 120 code points", () => {
    expect(defaultDeviceName("workstation")).toBe("thalovant-mcp on workstation");
    expect(defaultDeviceName("")).toBe("thalovant-mcp");
    const long = defaultDeviceName("😀".repeat(200));
    expect(Array.from(long)).toHaveLength(120);
  });
});

// -- over stdio: the protocol stream stays the protocol's ---------------------------------

/** The built server over stdio, driven with raw JSON-RPC lines so every byte of its stdout is seen. */
function rawStdio(env: Record<string, string>): {
  send: (message: Record<string, unknown>) => void;
  answer: (id: number) => Promise<Record<string, unknown>>;
  stdout: () => string;
  stderr: () => string;
} {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["dist/index.js"], { env, stdio: ["pipe", "pipe", "pipe"] });
  cleanups.push(() => {
    child.kill("SIGTERM");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return {
    send: (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    answer: async (id) => {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === id) return message;
        }
        await sleep(20);
      }
      throw new Error(`no answer to ${id}; stderr: ${stderr}`);
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** Every line on stdout is a JSON-RPC message, and none of them is a printed prompt. */
function onlyProtocol(stdout: string): void {
  const lines = stdout.split("\n").filter((line) => line.trim());
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const message = JSON.parse(line) as Record<string, unknown>;
    expect(message.jsonrpc).toBe("2.0");
  }
  expect(stdout).not.toContain("Opening your browser");
  expect(stdout).not.toContain("To sign in");
}

async function initialize(server: ReturnType<typeof rawStdio>): Promise<void> {
  server.send({ id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw-stdio", version: "0.0.0" } } });
  await server.answer(1);
  server.send({ method: "notifications/initialized" });
}

function toolAnswer(message: Record<string, unknown>): Record<string, unknown> {
  const result = message.result as { content: Array<{ text: string }>; isError?: boolean };
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("over stdio", () => {
  it("prints the browser prompt on stderr, never on the protocol stream, and answers the URL in the tool's answer", async () => {
    const api = await controlPlane();
    const opener = shims();
    const server = rawStdio(machineEnv({ THALOVANT_API_URL: api.url, DISPLAY: ":0" }, opener));
    await initialize(server);
    server.send({ id: 2, method: "tools/call", params: { name: "thalovant_begin_browser_login", arguments: {} } });
    const begun = toolAnswer(await server.answer(2));
    expect(begun).toMatchObject({ method: "browser", interval: 3, expiresIn: 300 });
    const url = begun.authorizationUrl as string;
    // The SDK's printed prompt went to the server's log.
    const until = Date.now() + 5_000;
    while (!server.stderr().includes(url) && Date.now() < until) await sleep(20);
    expect(server.stderr()).toContain(BROWSER.prompt.opening.replace("{url}", url));
    expect(await opener.openedWithin(url)).toBe(true);
    // The consent page names this server.
    expect(new Signing(url).pairs).toContainEqual(["device_name", defaultDeviceName()]);
    await approve(url);
    let polled: Record<string, unknown> = { outcome: "pending" };
    for (let id = 3; polled.outcome === "pending" && id < 200; id += 1) {
      server.send({ id, method: "tools/call", params: { name: "thalovant_poll_browser_login", arguments: { loginId: begun.loginId } } });
      polled = toolAnswer(await server.answer(id));
    }
    expect(polled).toMatchObject({ outcome: "approved", method: "browser", tokenId: "browser-token-1" });
    onlyProtocol(server.stdout());
    expect(server.stdout()).not.toContain(MINTED);
    expect(server.stdout()).not.toContain(CODE);
  }, 30_000);

  it("prints a device login's prompt on stderr too, when this computer has no browser to show", async () => {
    const api = await controlPlane();
    const opener = shims();
    const server = rawStdio(machineEnv({ THALOVANT_API_URL: api.url, DISPLAY: ":0", SSH_CONNECTION: "10.0.0.2 51022 10.0.0.9 22" }, opener));
    await initialize(server);
    server.send({ id: 2, method: "tools/call", params: { name: "thalovant_begin_browser_login", arguments: {} } });
    const begun = toolAnswer(await server.answer(2));
    expect(begun).toMatchObject({ method: "device", userCode: "ABCD-EFGH", verificationUri: "https://dash.example.invalid/activate" });
    expect(begun.next).toContain("thalovant_poll_browser_login");
    const until = Date.now() + 5_000;
    while (!server.stderr().includes("ABCD-EFGH") && Date.now() < until) await sleep(20);
    expect(server.stderr()).toContain("To sign in, visit https://dash.example.invalid/activate and enter the code ABCD-EFGH");
    // Over SSH the configuration is never asked for, and the device page is not opened.
    expect(api.seen.map((request) => request.path)).not.toContain("/v1/auth/native/config");
    expect(opener.opened()).toEqual([]);
    onlyProtocol(server.stdout());
    expect(server.stdout()).not.toContain(DEVICE_CODE);
  }, 30_000);

  it("lends a browser sign-in's token to every control-plane tool, and revokes it like a device sign-in's", async () => {
    const api = await controlPlane();
    const { client } = await stdioServer({ env: { THALOVANT_API_URL: api.url, DISPLAY: ":0" }, shims: shims() });
    cleanups.push(() => client.close());
    expect((await tool(client, "thalovant_get_hub", { hubId: "hub-1" })).error).toBe(true);
    expect((await tool(client, "thalovant_config_status", {})).json).toMatchObject({ transport: "stdio", browserLoginAvailable: true, deviceLoginSignedIn: false });

    const begun = await tool(client, "thalovant_begin_browser_login", { scopes: ["hubs:read", "clients:write"], deviceName: "Kitchen laptop" });
    expect(begun.error).toBe(false);
    const url = begun.json!.authorizationUrl as string;
    const signing = new Signing(url);
    expect(signing.pairs).toContainEqual(["scope", "hubs:read clients:write"]);
    expect(signing.pairs).toContainEqual(["device_name", "Kitchen laptop"]);
    await approve(url);
    const approved = await pollUntilEnded(client, begun.json!.loginId as string);
    expect(approved.json).toMatchObject({ outcome: "approved", method: "browser", tokenId: "browser-token-1", scopes: ["hubs:read", "clients:write"] });
    expect(await refused(signing.port)).toBe(true);
    // A sign-in that ended cannot be polled again.
    expect((await tool(client, "thalovant_poll_browser_login", { loginId: begun.json!.loginId })).error).toBe(true);

    const hub = await tool(client, "thalovant_get_hub", { hubId: "hub-1" });
    expect(hub.error).toBe(false);
    expect(api.seen.find((request) => request.path === "/v1/hubs/hub-1")?.authorization).toBe(`Bearer ${MINTED}`);
    expect((await tool(client, "thalovant_config_status", {})).json).toMatchObject({ deviceLoginSignedIn: true });

    const revoked = await tool(client, "thalovant_revoke_device_login", {});
    expect(revoked.json).toEqual({ revoked: true, tokenId: "browser-token-1" });
    expect(api.seen.find((request) => request.method === "DELETE")).toMatchObject({ path: "/v1/auth/api-tokens/browser-token-1", authorization: `Bearer ${MINTED}` });
    expect((await tool(client, "thalovant_get_hub", { hubId: "hub-1" })).error).toBe(true);
    for (const answer of [begun, approved, revoked, hub]) {
      expect(answer.text).not.toContain(MINTED);
      expect(answer.text).not.toContain(CODE);
    }
  }, 30_000);

  it("falls back to a device login when the API does not offer browser sign-in, and a forced browser sign-in says so", async () => {
    const api = await controlPlane({ browser: false });
    const opener = shims();
    const { client } = await stdioServer({ env: { THALOVANT_API_URL: api.url, DISPLAY: ":0" }, shims: opener });
    cleanups.push(() => client.close());
    const forced = await tool(client, "thalovant_begin_browser_login", { method: "browser" });
    expect(forced.error).toBe(true);
    expect(forced.text).toContain("status: HTTP 404");
    expect(forced.text).toContain("does not offer browser sign-in");
    expect(api.seen.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /v1/auth/native/config"]);

    const auto = await tool(client, "thalovant_begin_browser_login", {});
    expect(auto.json).toMatchObject({ method: "device", userCode: "ABCD-EFGH" });
    const approved = await pollUntilEnded(client, auto.json!.loginId as string);
    expect(approved.json).toMatchObject({ outcome: "approved", method: "device", tokenId: "device-token-1" });
    expect(opener.opened()).toEqual([]);
  }, 30_000);

  it("refuses an unknown or another principal's sign-in, and reaches only the configured API origin", async () => {
    const api = await controlPlane();
    const elsewhere = await controlPlane();
    const { client } = await stdioServer({ env: { THALOVANT_API_URL: api.url, DISPLAY: ":0" }, shims: shims() });
    cleanups.push(() => client.close());
    expect((await tool(client, "thalovant_poll_browser_login", { loginId: "0b9e7c1a-2f44-4d5e-8a3b-6c1d2e9f7a50" })).text).toContain("No browser sign-in in progress");
    const refusedOrigin = await tool(client, "thalovant_begin_browser_login", { apiUrl: elsewhere.url });
    expect(refusedOrigin.error).toBe(true);
    expect(refusedOrigin.text).toContain("configured Thalovant API origin");
    expect(elsewhere.seen).toHaveLength(0);
    expect(api.seen).toHaveLength(0);
  }, 15_000);
});

// -- over Streamable HTTP: device login, as before ----------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** `dist/index.js --http` on a port of its own, retried on a fresh port when another test took it first. */
async function httpServer(env: Record<string, string>): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await freePort();
    const child = spawn(process.execPath, ["dist/index.js", "--http"], {
      env: { ...env, MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: String(port), MCP_HTTP_ALLOWED_HOSTS: `127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => {
      child.kill("SIGTERM");
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const until = Date.now() + 10_000;
    while (Date.now() < until && child.exitCode === null) {
      const body = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json(), () => null).catch(() => null) as { name?: string; transport?: string } | null;
      if (body?.name === "thalovant" && body.transport === "streamable-http" && child.exitCode === null) return port;
      await sleep(100);
    }
    if (!stderr.includes("EADDRINUSE")) throw new Error(`HTTP server did not start: ${stderr}`);
  }
  throw new Error("HTTP server did not start on three ports.");
}

describe("over Streamable HTTP", () => {
  it("signs in with a device login exactly as before, even on a machine with a display, and refuses a browser sign-in", async () => {
    const api = await controlPlane();
    const opener = shims();
    const port = await httpServer(machineEnv({
      THALOVANT_API_URL: api.url,
      THALOVANT_ALLOW_SHARED_CREDENTIALS: "true",
      MCP_HTTP_AUTH_TOKEN: "browser-login-http-token",
      DISPLAY: ":0",
    }, opener));
    const client = new Client({ name: "thalovant-mcp-browser-login-http", version: "0.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer browser-login-http-token" } },
    }));
    cleanups.push(() => client.close());

    expect((await tool(client, "thalovant_config_status", {})).json).toMatchObject({ transport: "streamable-http", browserLoginAvailable: false });

    const forced = await tool(client, "thalovant_begin_browser_login", { method: "browser" });
    expect(forced.error).toBe(true);
    expect(forced.text).toContain("needs this server on the person's own computer (stdio)");
    expect(api.seen).toHaveLength(0);

    const auto = await tool(client, "thalovant_begin_browser_login", { deviceName: "Hosted agent" });
    expect(auto.error).toBe(false);
    expect(auto.json).toMatchObject({ method: "device", userCode: "ABCD-EFGH", verificationUri: "https://dash.example.invalid/activate", interval: 0, expiresIn: 600 });
    expect(auto.json!.next).toContain("thalovant_poll_device_login");
    // The device login's own begin: no configuration asked for, nothing opened, no loopback listener.
    expect(api.seen.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /v1/auth/device/authorize"]);
    expect(auto.text).not.toContain(DEVICE_CODE);

    // The device sign-in's own poll, as thalovant_begin_device_login's.
    const approved = await tool(client, "thalovant_poll_device_login", { loginId: auto.json!.loginId });
    expect(approved.json).toMatchObject({ outcome: "approved", tokenId: "device-token-1" });
    expect((await tool(client, "thalovant_poll_browser_login", { loginId: auto.json!.loginId })).text).toContain("thalovant_poll_device_login");

    const device = await tool(client, "thalovant_begin_device_login", {});
    expect(device.json).toMatchObject({ userCode: "ABCD-EFGH" });
    await sleep(200);
    expect(opener.opened()).toEqual([]);
  }, 30_000);
});

describe("registration", () => {
  it("offers the browser sign-in tools by default and leaves them out in read-only mode", async () => {
    const byDefault = await stdioServer({ env: { THALOVANT_API_TOKEN: "tvpat_x" } });
    cleanups.push(() => byDefault.client.close());
    const names = (await byDefault.client.listTools()).tools.map((item) => item.name);
    expect(names).toEqual(expect.arrayContaining(["thalovant_begin_browser_login", "thalovant_poll_browser_login"]));
    const readOnly = await stdioServer({ env: { THALOVANT_API_TOKEN: "tvpat_x", THALOVANT_MCP_READONLY: "1" } });
    cleanups.push(() => readOnly.client.close());
    const readOnlyNames = (await readOnly.client.listTools()).tools.map((item) => item.name);
    expect(readOnlyNames).not.toContain("thalovant_begin_browser_login");
    expect(readOnlyNames).not.toContain("thalovant_poll_browser_login");
    assert.ok(readOnlyNames.length > 0);
  }, 30_000);
});
