import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const API_TOKEN = "tvpat_security-test-token";

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
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

/**
 * Minimal fake control plane. Every request is recorded and answered 200 with
 * `body` (default `{ ok: true }`), so a tool's request shape and endpoint can be
 * asserted and its passthrough output inspected.
 */
async function startFakeControlPlane(body?: unknown): Promise<FakeControlPlane> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body: raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body ?? { ok: true, path: url.pathname }));
    });
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
  const client = new Client({ name: "thalovant-mcp-security", version: "0.0.0" }, { capabilities: {} });
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

function findRequest(fake: FakeControlPlane, method: string, path: string): RecordedRequest {
  const request = fake.requests.find((entry) => entry.method === method && entry.path === path);
  if (!request) {
    throw new Error(
      `No ${method} ${path} request was recorded. Saw: ${fake.requests.map((entry) => `${entry.method} ${entry.path}`).join(", ")}`,
    );
  }
  return request;
}

describe("M1: non-catalog skill sources are gated", () => {
  it("refuses a git skill source by default and makes no control-plane call", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: {
        runtimeGroupId: "rg-1",
        skillId: "skill-evil",
        sourceType: "git",
        sourceRef: "https://attacker.example/evil.git",
      },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("THALOVANT_ENABLE_GIT_SKILL_SOURCES");
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("refuses any non-catalog source (e.g. package) by default", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: { runtimeGroupId: "rg-1", skillId: "skill-x", sourceType: "package" },
    });

    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("still installs catalog skills by default", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const explicit = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: { runtimeGroupId: "rg-1", skillId: "skill-news", sourceType: "catalog" },
    });
    expect(explicit.isError ?? false).toBe(false);

    const implicit = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: { runtimeGroupId: "rg-1", skillId: "skill-weather" },
    });
    expect(implicit.isError ?? false).toBe(false);

    expect(fake.requests.filter((entry) => entry.path === "/v1/runtime-groups/rg-1/skills")).toHaveLength(2);
  }, 15_000);

  it("treats whitespace/case variants of catalog as catalog and forwards the canonical value", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    for (const variant of [" Catalog ", "CATALOG", "catalog "]) {
      const result = await client.callTool({
        name: "thalovant_install_runtime_group_skill",
        arguments: { runtimeGroupId: "rg-1", skillId: "skill-news", sourceType: variant },
      });
      expect(result.isError ?? false, `variant ${JSON.stringify(variant)} should be accepted`).toBe(false);
    }

    const installs = fake.requests.filter((entry) => entry.path === "/v1/runtime-groups/rg-1/skills");
    expect(installs).toHaveLength(3);
    // What is forwarded is the canonical "catalog" the gate validated, never the raw variant.
    for (const install of installs) {
      expect(install.body).toMatchObject({ source_type: "catalog" });
    }
  }, 20_000);

  it("does not let a whitespace/case variant of a non-catalog source bypass the gate", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    // Without the env flag, no non-catalog spelling may reach the control plane.
    for (const variant of [" git ", "GIT", "Git", " PACKAGE"]) {
      const result = await client.callTool({
        name: "thalovant_install_runtime_group_skill",
        arguments: {
          runtimeGroupId: "rg-1",
          skillId: "skill-evil",
          sourceType: variant,
          sourceRef: "https://attacker.example/evil.git",
        },
      });
      expect(result.isError, `variant ${JSON.stringify(variant)} should be rejected`).toBe(true);
    }
    expect(fake.requests).toHaveLength(0);
  }, 20_000);

  it("normalizes a non-catalog source before forwarding when the flag is set", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_API_URL: fake.url,
      THALOVANT_ENABLE_GIT_SKILL_SOURCES: "1",
    });

    const result = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: {
        runtimeGroupId: "rg-1",
        skillId: "skill-custom",
        sourceType: " Git ",
        sourceRef: "https://example.com/skill.git",
      },
    });
    expect(result.isError ?? false).toBe(false);
    expect(findRequest(fake, "POST", "/v1/runtime-groups/rg-1/skills").body).toMatchObject({ source_type: "git" });
  }, 15_000);

  it("allows a git skill source only when THALOVANT_ENABLE_GIT_SKILL_SOURCES is set", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_API_URL: fake.url,
      THALOVANT_ENABLE_GIT_SKILL_SOURCES: "1",
    });

    const result = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: {
        runtimeGroupId: "rg-1",
        skillId: "skill-custom",
        sourceType: "git",
        sourceRef: "https://example.com/skill.git",
      },
    });

    expect(result.isError ?? false).toBe(false);
    findRequest(fake, "POST", "/v1/runtime-groups/rg-1/skills");
  }, 15_000);

  it("annotates the install tool as destructive and reports the gate in config_status", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });

    const tools = await client.listTools();
    const install = tools.tools.find((tool) => tool.name === "thalovant_install_runtime_group_skill");
    expect(install?.annotations?.destructiveHint).toBe(true);

    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    expect(resultText(status)).toContain('"gitSkillSourcesEnabled": false');

    const enabled = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_ENABLE_GIT_SKILL_SOURCES: "true",
    });
    const enabledStatus = await enabled.callTool({ name: "thalovant_config_status", arguments: {} });
    expect(resultText(enabledStatus)).toContain('"gitSkillSourcesEnabled": true');
  }, 20_000);
});

describe("M2: client-identity save path is confined to the identity directory", () => {
  it("rejects a traversal savePath before any control-plane call", async () => {
    const fake = await startFakeControlPlane();
    const identityDir = join(tmpdir(), `mcp-id-${randomUUID()}`);
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_API_URL: fake.url,
      THALOVANT_MCP_IDENTITY_DIR: identityDir,
    });

    const result = await client.callTool({
      name: "thalovant_create_client_identity",
      arguments: { hubId: "hub-1", name: "edge", savePath: "../../etc/escape.json" },
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("identity directory");
    // No identity was created in the control plane for a rejected path.
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("rejects an absolute savePath outside the identity directory", async () => {
    const fake = await startFakeControlPlane();
    const identityDir = join(tmpdir(), `mcp-id-${randomUUID()}`);
    const outside = join(tmpdir(), `mcp-outside-${randomUUID()}.json`);
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_API_URL: fake.url,
      THALOVANT_MCP_IDENTITY_DIR: identityDir,
    });

    const result = await client.callTool({
      name: "thalovant_create_client_identity",
      arguments: { hubId: "hub-1", name: "edge", savePath: outside },
    });

    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("reports the identity directory in config_status and honors THALOVANT_MCP_IDENTITY_DIR", async () => {
    const identityDir = join(tmpdir(), `mcp-id-${randomUUID()}`);
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_MCP_IDENTITY_DIR: identityDir,
    });

    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    expect(resultText(status)).toContain(`"identityDir": ${JSON.stringify(identityDir)}`);
  }, 15_000);
});

describe("M4: analytics overview no longer exposes an admin mode", () => {
  it("does not advertise admin or ownerId on the analytics tool", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });

    const tools = await client.listTools();
    const analytics = tools.tools.find((tool) => tool.name === "thalovant_get_analytics_overview");
    const properties = (analytics?.inputSchema?.properties ?? {}) as Record<string, unknown>;

    expect(properties).not.toHaveProperty("admin");
    expect(properties).not.toHaveProperty("ownerId");
    // The plain overview surface is preserved.
    expect(properties).toHaveProperty("range");
    expect(properties).toHaveProperty("hubId");
  }, 15_000);

  it("calls the non-admin endpoint and never forwards an injected admin flag or ownerId", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    // Even if a client injects admin/ownerId (not in the schema), they must not
    // reach the control plane or select the admin analytics endpoint.
    const result = await client.callTool({
      name: "thalovant_get_analytics_overview",
      arguments: { range: "7d", admin: true, ownerId: "someone-else" },
    });
    expect(result.isError ?? false).toBe(false);

    expect(fake.requests.some((entry) => entry.path === "/v1/admin/analytics/overview")).toBe(false);
    const request = findRequest(fake, "GET", "/v1/analytics/overview");
    expect(request.query.range).toBe("7d");
    expect(request.query.owner_id).toBeUndefined();
  }, 15_000);
});

describe("M6: read-only mode registers only read-only tools", () => {
  it("hides write and destructive tools from tools/list when THALOVANT_MCP_READONLY is set", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_MCP_READONLY: "1" });

    const names = (await client.listTools()).tools.map((tool) => tool.name);

    // Read-only tools remain available.
    expect(names).toContain("thalovant_config_status");
    expect(names).toContain("thalovant_list_public_hubs");
    expect(names).toContain("thalovant_get_analytics_overview");

    // Write / destructive tools are not registered at all.
    expect(names).not.toContain("thalovant_create_hub");
    expect(names).not.toContain("thalovant_create_client_identity");
    expect(names).not.toContain("thalovant_install_runtime_group_skill");
    expect(names).not.toContain("thalovant_update_runtime_group_config");

    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    expect(resultText(status)).toContain('"readOnly": true');
  }, 15_000);

  it("registers write tools normally when read-only mode is off", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("thalovant_create_hub");
    expect(names).toContain("thalovant_install_runtime_group_skill");

    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    expect(resultText(status)).toContain('"readOnly": false');
  }, 15_000);
});

describe("M5: redaction covers additional secret-ish keys", () => {
  it("redacts device_code, user_code, psk, cert, and jwt in tool output", async () => {
    const secretBody = {
      name: "kitchen",
      jwt: "eyJhbGciOi.header.sig",
      device_code: "DC-123456",
      user_code: "WXYZ-1234",
      psk: "pre-shared-key-value",
      cert: "-----BEGIN CERTIFICATE-----",
      access_token: "at-should-already-be-redacted",
      nested: { user_code: "nested-user-code", label: "keep-me" },
    };
    const fake = await startFakeControlPlane(secretBody);
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_get_hub", arguments: { hubId: "hub-1" } });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(resultText(result)) as Record<string, any>;

    expect(payload.jwt).toBe("[redacted]");
    expect(payload.device_code).toBe("[redacted]");
    expect(payload.user_code).toBe("[redacted]");
    expect(payload.psk).toBe("[redacted]");
    expect(payload.cert).toBe("[redacted]");
    expect(payload.access_token).toBe("[redacted]");
    expect(payload.nested.user_code).toBe("[redacted]");
    // Non-secret fields are preserved.
    expect(payload.name).toBe("kitchen");
    expect(payload.nested.label).toBe("keep-me");
  }, 15_000);
});
