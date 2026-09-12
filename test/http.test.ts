import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
    const port = await freePort();
    const child = spawnHttpServer(port, { MCP_HTTP_AUTH_TOKEN: "shutdown-test-token" });
    await waitForHealth(port);
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
    const port = await freePort();
    spawnHttpServer(port, {
      MCP_HTTP_AUTH_TOKEN: "test-http-token",
      MCP_HTTP_ALLOWED_ORIGINS: "https://agent.example",
    });
    await waitForHealth(port);

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
    const port = await freePort();
    const audience = `http://127.0.0.1:${port}/mcp`;
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
    const child = spawnHttpServer(port, {
      MCP_HTTP_AUTH_MODE: "jwt",
      MCP_OAUTH_ISSUER: oauth.url,
      MCP_OAUTH_JWKS_URL: `${oauth.url}/jwks`,
      MCP_OAUTH_AUDIENCE: audience,
      MCP_OAUTH_AUTHORIZATION_SERVERS: oauth.url,
      MCP_OAUTH_REQUIRED_SCOPES: "mcp:thalovant",
    });

    try {
      await waitForHealth(port);
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
      child.kill("SIGTERM");
      await oauth.close();
    }
  }, 20_000);

  it("validates introspected OAuth tokens and writes JSONL audit events", async () => {
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), "thalovant-mcp-audit-"));
    const auditFile = join(dir, "audit.jsonl");
    const audience = `http://127.0.0.1:${port}/mcp`;
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
    const child = spawnHttpServer(port, {
      MCP_HTTP_AUTH_MODE: "introspection",
      MCP_OAUTH_INTROSPECTION_URL: `${oauth.url}/introspect`,
      MCP_OAUTH_CLIENT_ID: "mcp-server-client",
      MCP_OAUTH_CLIENT_SECRET: "mcp-server-secret",
      MCP_OAUTH_AUDIENCE: audience,
      MCP_AUDIT_LOG: "file",
      MCP_AUDIT_LOG_FILE: auditFile,
    });

    try {
      await waitForHealth(port);
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
      child.kill("SIGTERM");
      await oauth.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("enforces server-side tool policy", async () => {
    const port = await freePort();
    const child = spawnHttpServer(port, {
      MCP_HTTP_AUTH_TOKEN: "policy-token",
      MCP_TOOL_DENYLIST: "thalovant_config_status",
    });
    await waitForHealth(port);

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
    const port = await freePort();
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
    const child = spawnHttpServer(port, {
      MCP_HTTP_AUTH_TOKEN: "credential-token",
      THALOVANT_PRINCIPAL_CREDENTIALS_DIR: dir,
    });
    await waitForHealth(port);

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
    const port = await freePort();
    const child = spawnHttpServer(port, {
      MCP_HTTP_AUTH_TOKEN: "origin-fixture-token",
      THALOVANT_PRINCIPAL_CREDENTIALS_DIR: dir,
      THALOVANT_API_TOKEN: "unused-shared-token",
      THALOVANT_API_URL: untrusted.url,
    });
    const client = new Client({ name: "thalovant-principal-origin-test", version: "0.0.0" }, { capabilities: {} });
    try {
      await waitForHealth(port);
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
      await stopChild(child);
      await Promise.all([configured.close(), untrusted.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

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

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("HTTP MCP server did not become healthy.");
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
