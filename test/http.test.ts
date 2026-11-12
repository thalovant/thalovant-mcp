import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChild(child)));
});

describe("streamable HTTP MCP server", () => {
  it.each(["SIGTERM", "SIGINT"] as const)("closes an active MCP session and exits cleanly on %s", async (signal) => {
    const { port, child } = await startMcpHttpServer(() => ({ MCP_HTTP_AUTH_TOKEN: "shutdown-test-token" }));
    const client = new Client({ name: "shutdown-regression", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer shutdown-test-token" } },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("MCP did not shut down cleanly")), 3_000);
        child.once("exit", (code, exitSignal) => { clearTimeout(timeout); resolve({ code, signal: exitSignal }); });
      });
      child.kill(signal);
      expect(await result).toEqual({ code: 0, signal: null });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("requires bearer auth and serves MCP over Streamable HTTP", async () => {
    const { port } = await startMcpHttpServer(() => ({
      MCP_HTTP_AUTH_TOKEN: "test-http-token",
      MCP_HTTP_ALLOWED_ORIGINS: "https://agent.example",
    }));

    const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
    expect(metadata.status).toBe(200);
    const metadataJson = await metadata.json();
    expect(metadataJson.resource).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(metadataJson.scopes_supported).toContain("mcp:thalovant");

    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata");

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer test-http-token",
          Origin: "https://agent.example",
        },
      },
    });
    const client = new Client({ name: "thalovant-http-smoke", version: "0.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const manifest = JSON.parse(await readFile("package.json", "utf8"));
      expect(client.getServerVersion()?.version).toBe(manifest.version);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("thalovant_config_status");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("validates JWT bearer tokens with JWKS, issuer, audience, and scope", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.alg = "RS256";
    jwk.kid = "test-key";
    jwk.use = "sig";
    const oauth = await startTestHttpServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/jwks") {
        sendJsonResponse(res, 200, { keys: [jwk] });
        return;
      }
      sendJsonResponse(res, 404, { error: "not found" });
    });
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      const started = await startMcpHttpServer((port) => ({
        MCP_HTTP_AUTH_MODE: "jwt",
        MCP_OAUTH_ISSUER: oauth.url,
        MCP_OAUTH_JWKS_URL: `${oauth.url}/jwks`,
        MCP_OAUTH_AUDIENCE: mcpUrl(port),
        MCP_OAUTH_AUTHORIZATION_SERVERS: oauth.url,
        MCP_OAUTH_REQUIRED_SCOPES: "mcp:thalovant",
      }));
      child = started.child;
      const { port } = started;
      const audience = mcpUrl(port);
      const missingScopeToken = await new SignJWT({ scope: "other:scope", client_id: "codex-test-client" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(oauth.url)
        .setAudience(audience)
        .setSubject("user-123")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      const forbidden = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${missingScopeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(forbidden.status).toBe(403);

      const token = await new SignJWT({ scope: "mcp:thalovant other:scope", client_id: "codex-test-client" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(oauth.url)
        .setAudience(audience)
        .setSubject("user-123")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      const client = new Client({ name: "thalovant-http-jwt", version: "0.0.0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("thalovant_config_status");
      } finally {
        await client.close();
      }
    } finally {
      child?.kill("SIGTERM");
      await oauth.close();
    }
  }, 20_000);

  it("validates introspected OAuth tokens and writes JSONL audit events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thalovant-mcp-audit-"));
    const auditFile = join(dir, "audit.jsonl");
    // Known once the server holds its port; the introspection answers come after that.
    let audience = "";
    let introspectionAuthorization: string | undefined;
    let introspectionBody = "";
    const oauth = await startTestHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/introspect") {
        sendJsonResponse(res, 404, { error: "not found" });
        return;
      }
      introspectionAuthorization = req.headers.authorization;
      introspectionBody = await readRequestText(req);
      const params = new URLSearchParams(introspectionBody);
      sendJsonResponse(res, 200, {
        active: params.get("token") === "opaque-token",
        scope: "mcp:thalovant",
        aud: audience,
        sub: "oauth-user",
        client_id: "oauth-client",
        exp: Math.floor(Date.now() / 1_000) + 300,
      });
    });
    let child: ChildProcessWithoutNullStreams | undefined;

    try {
      const started = await startMcpHttpServer((port) => ({
        MCP_HTTP_AUTH_MODE: "introspection",
        MCP_OAUTH_INTROSPECTION_URL: `${oauth.url}/introspect`,
        MCP_OAUTH_CLIENT_ID: "mcp-server-client",
        MCP_OAUTH_CLIENT_SECRET: "mcp-server-secret",
        MCP_OAUTH_AUDIENCE: mcpUrl(port),
        MCP_AUDIT_LOG: "file",
        MCP_AUDIT_LOG_FILE: auditFile,
      }));
      child = started.child;
      const { port } = started;
      audience = mcpUrl(port);
      const client = new Client({ name: "thalovant-http-introspection", version: "0.0.0" }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer opaque-token" } },
      });
      try {
        await client.connect(transport);
        const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
        expect(status.content).toHaveLength(1);
      } finally {
        await client.close();
      }

      expect(introspectionAuthorization).toBe(`Basic ${Buffer.from("mcp-server-client:mcp-server-secret").toString("base64")}`);
      expect(new URLSearchParams(introspectionBody).get("token")).toBe("opaque-token");
      const auditEvents = (await readFile(auditFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        auditEvents.some(
          (event) =>
            event.event === "mcp.tool" &&
            event.tool === "thalovant_config_status" &&
            event.principalId === "oauth-user" &&
            event.clientId === "oauth-client" &&
            event.status === "ok",
        ),
      ).toBe(true);
    } finally {
      child?.kill("SIGTERM");
      await oauth.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("enforces server-side tool policy", async () => {
    const { port, child } = await startMcpHttpServer(() => ({
      MCP_HTTP_AUTH_TOKEN: "policy-token",
      MCP_TOOL_DENYLIST: "thalovant_config_status",
    }));

    const client = new Client({ name: "thalovant-http-policy", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer policy-token" } },
    });
    try {
      await client.connect(transport);
      const denied = await client.callTool({
        name: "thalovant_config_status",
        arguments: {},
      });
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.type === "text" ? denied.content[0].text : "").toMatch(/disabled by server policy/i);
    } finally {
      await client.close();
      child.kill("SIGTERM");
    }
  }, 20_000);

  it("loads per-principal policy from credential files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thalovant-mcp-"));
    const principalId = sha256("credential-token").slice(0, 32);
    const credentialFile = join(dir, `${sha256(principalId)}.json`);
    await writeFile(
      credentialFile,
      JSON.stringify({
        allowedTools: ["thalovant_config_status"],
        deniedTools: ["thalovant_list_public_hubs"],
      }),
      { mode: 0o600 },
    );
    const { port, child } = await startMcpHttpServer(() => ({
      MCP_HTTP_AUTH_TOKEN: "credential-token",
      THALOVANT_PRINCIPAL_CREDENTIALS_DIR: dir,
    }));

    const client = new Client({ name: "thalovant-http-credentials", version: "0.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer credential-token" } },
    });
    try {
      await client.connect(transport);
      const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
      expect(status.content).toHaveLength(1);
      const denied = await client.callTool({ name: "thalovant_list_public_hubs", arguments: { limit: 1 } });
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.type === "text" ? denied.content[0].text : "").toMatch(/disabled for this principal/i);
    } finally {
      await client.close();
      child.kill("SIGTERM");
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
  it("keeps a remote principal's API token on its configured origin", async () => {
    const expectedAuthorization = "Bearer synthetic-principal-api-token";
    const configuredRequests: Array<string | undefined> = [];
    let untrustedRequests = 0;
    const configured = await startTestHttpServer((req, res) => {
      configuredRequests.push(req.headers.authorization);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hubs: [] }));
    });
    const untrusted = await startTestHttpServer((_req, res) => {
      untrustedRequests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hubs: [] }));
    });
    const dir = await mkdtemp(join(tmpdir(), "thalovant-mcp-origin-"));
    const principalId = sha256("origin-fixture-token").slice(0, 32);
    await writeFile(join(dir, `${sha256(principalId)}.json`), JSON.stringify({
      control: { apiUrl: configured.url, accessToken: "synthetic-principal-api-token" },
    }), { mode: 0o600 });
    const client = new Client({ name: "thalovant-principal-origin-test", version: "0.0.0" }, { capabilities: {} });
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      const started = await startMcpHttpServer(() => ({
        MCP_HTTP_AUTH_TOKEN: "origin-fixture-token",
        THALOVANT_PRINCIPAL_CREDENTIALS_DIR: dir,
        THALOVANT_API_TOKEN: "unused-shared-token",
        THALOVANT_API_URL: untrusted.url,
      }));
      child = started.child;
      const { port } = started;
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer origin-fixture-token" } },
      }));
      const denied = await client.callTool({ name: "thalovant_list_hubs", arguments: { apiUrl: untrusted.url } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toMatch(/configured Thalovant credential origin/);
      expect(configuredRequests).toHaveLength(0);
      expect(untrustedRequests).toBe(0);
      for (const args of [{ apiUrl: configured.url + "/" }, {}]) {
        const result = await client.callTool({ name: "thalovant_list_hubs", arguments: args });
        expect(result.isError).not.toBe(true);
      }
      expect(configuredRequests).toEqual([expectedAuthorization, expectedAuthorization]);
      expect(untrustedRequests).toBe(0);
    } finally {
      await client.close();
      if (child) await stopChild(child);
      await Promise.all([configured.close(), untrusted.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("serves the chat app tools over Streamable HTTP with the principal's own credential", async () => {
    const bridgeId = "6f1c8a1e-3b2d-4c5e-8f9a-0b1c2d3e4f50";
    const seen: Array<{ method?: string; path: string; authorization?: string; body: string }> = [];
    const api = await startTestHttpServer(async (req, res) => {
      const body = await readRequestText(req);
      seen.push({ method: req.method, path: new URL(req.url ?? "/", "http://127.0.0.1").pathname, authorization: req.headers.authorization, body });
      sendJsonResponse(res, 200, {
        id: bridgeId, hub_id: "hub-1", owner_id: "owner-1", network: "telegram",
        connector: { id: "telegram", name: "Telegram", version: "1.4.0" }, settings: {}, secrets_set: ["token"],
        state: "active", resource_name: "bridge-x", bot: { user_id: "1", username: "KitchenHubBot", avatar_url: "https://api.example/avatar" },
        invite_links: null, allowed: [{ id: "-1001" }], require_mention: true, session_scope: "person",
        paused: req.method === "PATCH", hold: null, etag: "etag-1", token_updated_at: "2026-11-01T10:00:00Z",
        created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z",
        status: req.method === "PATCH"
          ? { phase: "Paused", ready: false, reason: "Paused", applied: false, source: "operator", message: "platform-only sentence" }
          : { phase: "Ready", ready: true, reason: "Connected", applied: true, source: "operator", message: "platform-only sentence" },
      });
    });
    const dir = await mkdtemp(join(tmpdir(), "thalovant-mcp-bridges-"));
    const principalId = sha256("bridge-fixture-token").slice(0, 32);
    await writeFile(join(dir, `${sha256(principalId)}.json`), JSON.stringify({
      control: { apiUrl: api.url, accessToken: "synthetic-bridge-principal-token" },
    }), { mode: 0o600 });
    let child: ChildProcessWithoutNullStreams | undefined;
    let owner: Client | undefined;
    let other: Client | undefined;
    try {
      const started = await startMcpHttpServer(() => ({
        MCP_HTTP_AUTH_TOKENS: "bridge-fixture-token,other-fixture-token",
        THALOVANT_PRINCIPAL_CREDENTIALS_DIR: dir,
      }));
      child = started.child;
      const connect = async (token: string) => {
        const client = new Client({ name: "thalovant-bridge-http-test", version: "0.0.0" }, { capabilities: {} });
        await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(started.port)), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }));
        return client;
      };
      owner = await connect("bridge-fixture-token");
      const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text?: string }>)[0]?.text ?? "";

      const read = await owner.callTool({ name: "thalovant_get_bridge", arguments: { bridgeId } });
      expect(read.isError ?? false, text(read)).toBe(false);
      expect(JSON.parse(text(read)).status.summary).toMatch(/^Connected: the bridge is running/);
      const paused = await owner.callTool({ name: "thalovant_pause_bridge", arguments: { bridgeId, etag: "etag-1" } });
      expect(paused.isError ?? false, text(paused)).toBe(false);
      expect(JSON.parse(text(paused)).status.summary).toMatch(/^Paused by its owner/);
      expect(`${text(read)}${text(paused)}`).not.toContain("platform-only sentence");
      expect(seen.map(({ method, path, authorization, body }) => [method, path, authorization, body])).toEqual([
        ["GET", `/v1/bridges/${bridgeId}`, "Bearer synthetic-bridge-principal-token", ""],
        ["PATCH", `/v1/bridges/${bridgeId}`, "Bearer synthetic-bridge-principal-token", JSON.stringify({ paused: true })],
      ]);

      // Another principal has no credential of its own and may not borrow one.
      other = await connect("other-fixture-token");
      const denied = await other.callTool({ name: "thalovant_get_bridge", arguments: { bridgeId } });
      expect(denied.isError).toBe(true);
      expect(text(denied)).toContain("THALOVANT_API_TOKEN");
      expect(seen).toHaveLength(2);
    } finally {
      await owner?.close();
      await other?.close();
      if (child) await stopChild(child);
      await api.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("asks the person to confirm an urgent announcement over Streamable HTTP, and refuses a client that cannot ask", async () => {
    const hubId = "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
    const seen: Array<{ method?: string; path: string; body: string }> = [];
    const api = await startTestHttpServer(async (req, res) => {
      const body = await readRequestText(req);
      seen.push({ method: req.method, path: new URL(req.url ?? "/", "http://127.0.0.1").pathname, body });
      sendJsonResponse(res, 202, {
        id: "11111111-2222-4333-8444-555555555555", status: "sending", priority: "urgent", created_at: "2026-11-11T10:00:00Z", deliveries: [], acked_by: null,
      });
    });
    const dir = await mkdtemp(join(tmpdir(), "thalovant-mcp-intercom-"));
    const principalId = sha256("intercom-fixture-token").slice(0, 32);
    await writeFile(join(dir, `${sha256(principalId)}.json`), JSON.stringify({
      control: { apiUrl: api.url, accessToken: "synthetic-intercom-principal-token" },
    }), { mode: 0o600 });
    let child: ChildProcessWithoutNullStreams | undefined;
    const clients: Client[] = [];
    try {
      const eventStoreFile = join(dir, "events", "stream.jsonl");
      const started = await startMcpHttpServer(() => ({
        MCP_HTTP_AUTH_TOKENS: "intercom-fixture-token",
        THALOVANT_PRINCIPAL_CREDENTIALS_DIR: dir,
        THALOVANT_ENABLE_INTERCOM_ANNOUNCE: "1",
        MCP_EVENT_STORE_FILE: eventStoreFile,
      }));
      child = started.child;
      const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text?: string }>)[0]?.text ?? "";
      const connect = async (answer?: () => { action: "accept" | "decline"; content?: Record<string, unknown> }, shown: string[] = []) => {
        const client = new Client({ name: "thalovant-intercom-http-test", version: "0.0.0" }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
        if (answer) {
          client.setRequestHandler(ElicitRequestSchema, async (request) => {
            shown.push((request.params as { message: string }).message);
            return answer();
          });
        }
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(started.port)), {
          requestInit: { headers: { Authorization: "Bearer intercom-fixture-token" } },
        }));
        return client;
      };
      const args = { hubId, text: "Dinner is ready", rooms: ["kitchen"], priority: "urgent", confirmUrgent: true, repeatTimes: 2, repeatIntervalSeconds: 30 };

      // A client that confirms: the prompt travels back on the call's own stream and the announcement goes out.
      const shown: string[] = [];
      const confirming = await connect(() => ({ action: "accept", content: { confirm: true } }), shown);
      const sent = await confirming.callTool({ name: "thalovant_intercom_announce", arguments: args });
      expect(sent.isError ?? false, text(sent)).toBe(false);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toContain(`Hub: ${hubId}`);
      expect(shown[0]).toContain("Priority: URGENT");
      expect(shown[0]).toContain("Text: \"Dinner is ready\"");
      expect(seen.map((row) => `${row.method} ${row.path}`)).toEqual([`POST /v1/hubs/${hubId}/intercom/announce`]);

      // The file-backed event store (MCP_EVENT_STORE_FILE) is on, and it records the stream's messages, but the
      // confirmation prompt, which shows the announcement's text, is never written to disk.
      const stored = await readFile(eventStoreFile, "utf8");
      expect(stored.trim().length, "the event store is in use").toBeGreaterThan(0);
      expect(stored).not.toContain("elicitation/create");
      expect(stored).not.toContain("Dinner is ready");

      // A person who declines: nothing more is sent.
      const declining = await connect(() => ({ action: "decline" }));
      const declined = await declining.callTool({ name: "thalovant_intercom_announce", arguments: args });
      expect(declined.isError).toBe(true);
      expect(text(declined)).toContain("did not confirm");

      // A client without elicitation: refused, whatever confirmUrgent says.
      const mute = await connect();
      const refused = await mute.callTool({ name: "thalovant_intercom_announce", arguments: args });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("does not support elicitation");
      expect(seen).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      if (child) await stopChild(child);
      await api.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses urgent and allowAll at once, instead of hanging, when the HTTP server answers in JSON-response mode", async () => {
    const hubId = "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
    const seen: string[] = [];
    const api = await startTestHttpServer(async (req, res) => {
      await readRequestText(req);
      seen.push(`${req.method} ${req.url}`);
      sendJsonResponse(res, 202, { id: "11111111-2222-4333-8444-555555555555", status: "sending", priority: "urgent", deliveries: [] });
    });
    const dir = await mkdtemp(join(tmpdir(), "thalovant-mcp-intercom-"));
    const principalId = sha256("intercom-json-token").slice(0, 32);
    await writeFile(join(dir, `${sha256(principalId)}.json`), JSON.stringify({
      control: { apiUrl: api.url, accessToken: "synthetic-intercom-principal-token" },
    }), { mode: 0o600 });
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: Client | undefined;
    try {
      const started = await startMcpHttpServer(() => ({
        MCP_HTTP_AUTH_TOKENS: "intercom-json-token",
        MCP_HTTP_ENABLE_JSON_RESPONSE: "true",
        THALOVANT_PRINCIPAL_CREDENTIALS_DIR: dir,
        THALOVANT_ENABLE_INTERCOM_ANNOUNCE: "1",
      }));
      child = started.child;
      client = new Client({ name: "thalovant-intercom-json-test", version: "0.0.0" }, { capabilities: { elicitation: { form: {} } } });
      let asked = 0;
      client.setRequestHandler(ElicitRequestSchema, async () => { asked += 1; return { action: "accept", content: { confirm: true } }; });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(started.port)), {
        requestInit: { headers: { Authorization: "Bearer intercom-json-token" } },
      }));
      const urgent = await client.callTool({ name: "thalovant_intercom_announce", arguments: { hubId, text: "Dinner is ready", rooms: ["kitchen"], priority: "urgent", confirmUrgent: true } });
      expect(urgent.isError).toBe(true);
      expect((urgent.content as Array<{ text?: string }>)[0]?.text).toContain("JSON-response mode");
      const everyone = await client.callTool({ name: "thalovant_intercom_announce", arguments: { hubId, text: "Dinner is ready", allowAll: true } });
      expect(everyone.isError).toBe(true);
      // A normal announcement to a named room still goes out: it asks nobody.
      const normal = await client.callTool({ name: "thalovant_intercom_announce", arguments: { hubId, text: "Dinner is ready", rooms: ["kitchen"] } });
      expect(normal.isError ?? false).toBe(false);
      expect(asked).toBe(0);
      expect(seen).toHaveLength(1);
    } finally {
      await client?.close();
      if (child) await stopChild(child);
      await api.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("moves to a fresh port when another loopback server takes the freed one", async () => {
    // What a fake control plane from another test file does when it is given the port
    // freePort() just released: it answers every path, /healthz included, with 200.
    const impostorPaths: string[] = [];
    const impostor = await startTestHttpServer((req, res) => {
      impostorPaths.push(req.url ?? "");
      sendJsonResponse(res, 200, { ok: true, path: req.url });
    });
    const taken = Number(new URL(impostor.url).port);
    const ports = [taken];
    const client = new Client({ name: "thalovant-port-race-test", version: "0.0.0" }, { capabilities: {} });
    try {
      const { port } = await startMcpHttpServer(
        () => ({ MCP_HTTP_AUTH_TOKEN: "port-race-token" }),
        async () => ports.shift() ?? freePort(),
      );
      expect(port).not.toBe(taken);
      expect(impostorPaths).toContain("/healthz");
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl(port)), {
        requestInit: { headers: { Authorization: "Bearer port-race-token" } },
      }));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("thalovant_config_status");
      expect(impostorPaths.every((path) => path === "/healthz")).toBe(true);
    } finally {
      await client.close();
      await impostor.close();
    }
  }, 30_000);
});

function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate test port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

/**
 * Starts `dist/index.js --http` and returns it once it answers on its own port.
 *
 * `freePort()` releases the port it found before the child binds it, and the other test
 * files' loopback servers (listening on port 0, answering every path with 200) run in
 * parallel workers and can be given that port in between. The child then exits on
 * EADDRINUSE while the other server answers `/healthz`. So only this server's health body
 * counts as ready, from a child that is still running, and a child that lost its port is
 * replaced on a fresh one. `envFor` builds the environment for each port tried.
 */
async function startMcpHttpServer(
  envFor: (port: number) => Record<string, string>,
  pickPort: () => Promise<number> = freePort,
): Promise<{ port: number; child: ChildProcessWithoutNullStreams }> {
  const attempts: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await pickPort();
    const child = spawnHttpServer(port, envFor(port));
    const outcome = await waitForOwnHealth(child, port);
    if (outcome.ready) return { port, child };
    attempts.push(`port ${port}: ${outcome.reason}`);
    if (!outcome.portTaken) break;
  }
  throw new Error(`HTTP MCP server did not start (${attempts.join("; ")}).`);
}

async function waitForOwnHealth(
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<{ ready: true } | { ready: false; portTaken: boolean; reason: string }> {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  const deadline = Date.now() + 10_000;
  let last = "no answer";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      // Read the rest of stderr before saying why it stopped.
      await new Promise<void>((resolve) => {
        if (child.stderr.readableEnded) return resolve();
        const timer = setTimeout(resolve, 1_000);
        child.stderr.once("end", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return {
        ready: false,
        portTaken: stderr.includes("EADDRINUSE"),
        reason: `exited (${child.exitCode ?? child.signalCode}): ${stderr.trim() || "no output"}`,
      };
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = (await response.json().catch(() => null)) as { name?: unknown; transport?: unknown } | null;
      if (response.ok && body?.name === "thalovant" && body.transport === "streamable-http" && child.exitCode === null) {
        return { ready: true };
      }
      last = `${response.status} ${JSON.stringify(body)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ready: false, portTaken: false, reason: `not healthy within 10 s (last: ${last}): ${stderr.trim() || "no output"}` };
}

function spawnHttpServer(port: number, env: Record<string, string>): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["dist/index.js", "--http"], {
    cwd: process.cwd(),
    env: httpServerEnv(port, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function httpServerEnv(port: number, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("MCP_") || key.startsWith("THALOVANT_")) {
      delete env[key];
    }
  }
  return {
    ...env,
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_ALLOWED_HOSTS: `127.0.0.1:${port},localhost:${port}`,
    MCP_HTTP_RATE_LIMIT_MAX: "1000",
    ...overrides,
  };
}

async function startTestHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createHttpServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJsonResponse(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate test HTTP server port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function sendJsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

async function readRequestText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
