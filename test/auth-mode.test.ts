import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const API_TOKEN = "tvpat_auth-mode-test-token";
const LOGIN_ISSUED_TOKEN = "login-issued-access-token";

interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
}

interface FakeControlPlane {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startFakeControlPlane(): Promise<FakeControlPlane> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push({
      method: req.method ?? "GET",
      path,
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && path === "/v1/auth/token") {
      res.end(JSON.stringify({ access_token: LOGIN_ISSUED_TOKEN, token_type: "bearer" }));
      return;
    }
    if (path === "/v1/hubs") {
      res.end(JSON.stringify({ data: [], next_cursor: null }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeControlPlane = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  cleanups.push(fake.close);
  return fake;
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("THALOVANT_") || key.startsWith("MCP_")) continue;
    env[key] = value;
  }
  return env;
}

async function connectStdioClient(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...baseEnv(), ...env },
  });
  const client = new Client({ name: "thalovant-mcp-auth-mode", version: "0.0.0" }, { capabilities: {} });
  cleanups.push(() => client.close());
  await client.connect(transport);
  return client;
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

describe("control-plane auth modes", () => {
  it("uses THALOVANT_API_TOKEN directly and never calls the login endpoint", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_API_URL: fake.url,
    });

    const result = await client.callTool({ name: "thalovant_list_hubs", arguments: {} });
    expect(result.isError ?? false).toBe(false);

    const loginCalls = fake.requests.filter((request) => request.path === "/v1/auth/token");
    expect(loginCalls).toHaveLength(0);
    const hubCalls = fake.requests.filter((request) => request.path === "/v1/hubs");
    expect(hubCalls.length).toBeGreaterThan(0);
    expect(hubCalls[0]?.authorization).toBe(`Bearer ${API_TOKEN}`);
  }, 15_000);

  it("prefers THALOVANT_API_TOKEN over THALOVANT_ACCESS_TOKEN", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_ACCESS_TOKEN: "legacy-access-token",
      THALOVANT_API_URL: fake.url,
    });

    const result = await client.callTool({ name: "thalovant_list_hubs", arguments: {} });
    expect(result.isError ?? false).toBe(false);

    const hubCalls = fake.requests.filter((request) => request.path === "/v1/hubs");
    expect(hubCalls[0]?.authorization).toBe(`Bearer ${API_TOKEN}`);
  }, 15_000);

  it("falls back to email/password login when no token is configured", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({
      THALOVANT_EMAIL: "user@example.com",
      THALOVANT_PASSWORD: "test-password",
      THALOVANT_API_URL: fake.url,
    });

    const result = await client.callTool({ name: "thalovant_list_hubs", arguments: {} });
    expect(result.isError ?? false).toBe(false);

    const loginCalls = fake.requests.filter((request) => request.path === "/v1/auth/token");
    expect(loginCalls).toHaveLength(1);
    expect(loginCalls[0]?.method).toBe("POST");
    const hubCalls = fake.requests.filter((request) => request.path === "/v1/hubs");
    expect(hubCalls[0]?.authorization).toBe(`Bearer ${LOGIN_ISSUED_TOKEN}`);

    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    expect(resultText(status)).toContain('"controlPlaneAuthMode": "email-password"');
  }, 15_000);

  it("fails authenticated tools with a clear error when no auth is configured", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({
      THALOVANT_API_URL: fake.url,
    });

    const result = await client.callTool({ name: "thalovant_list_hubs", arguments: {} });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("THALOVANT_API_TOKEN");
    expect(text).toContain("THALOVANT_EMAIL/THALOVANT_PASSWORD");
    expect(fake.requests).toHaveLength(0);

    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    expect(resultText(status)).toContain('"controlPlaneAuthMode": "none"');
  }, 15_000);

  it("reports api-token mode in config status without leaking the token", async () => {
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
    });

    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    const text = resultText(status);
    expect(text).toContain('"controlPlaneAuthMode": "api-token"');
    expect(text).toContain('"hasApiToken": true');
    expect(text).not.toContain(API_TOKEN);
  }, 15_000);
});
