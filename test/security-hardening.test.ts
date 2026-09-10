import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
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
  authorization?: string;
}

interface FakeControlPlane {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
  ca?: string;
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
async function startFakeControlPlane(body?: unknown, options: { tls?: boolean; redirect?: { status: number; location: string } } = {}): Promise<FakeControlPlane> {
  const requests: RecordedRequest[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse) => {
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
        authorization: req.headers.authorization,
      });
      if (options.redirect) {
        res.writeHead(options.redirect.status, { Location: options.redirect.location });
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body ?? { ok: true, path: url.pathname }));
    });
  };
  let ca: string | undefined;
  let server: Server;
  if (options.tls) {
    const directory = await mkdtemp(join(tmpdir(), "mcp-control-tls-"));
    ca = join(directory, "tls.crt");
    const key = join(directory, "tls.key");
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", ca, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"]);
    server = createHttpsServer({ key: await readFile(key), cert: await readFile(ca) }, handler);
  } else {
    server = createServer(handler);
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeControlPlane = {
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${port}`,
    ca,
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

describe("control-plane credential origin", () => {
  it("sanitizes invalid configured URLs without exposing embedded credentials", async () => {
    const client = await connectStdioClient({ THALOVANT_API_URL: "https://user:synthetic-do-not-log@", THALOVANT_API_TOKEN: API_TOKEN });
    const result = await client.callTool({ name: "thalovant_list_hubs", arguments: {} });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("API URL is invalid");
    expect(resultText(result)).not.toContain("synthetic-do-not-log");
  });

  it.each<{ label: string; credentials: Record<string, string> }>([
    { label: "API token", credentials: { THALOVANT_API_TOKEN: API_TOKEN } },
    { label: "password login", credentials: { THALOVANT_EMAIL: "synthetic@example.invalid", THALOVANT_PASSWORD: "synthetic-password" } },
  ])("rejects cross-origin overrides before sending configured $label credentials", async ({ credentials }) => {
    const configured = await startFakeControlPlane();
    const untrusted = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_URL: configured.url, ...credentials });
    const result = await client.callTool({ name: "thalovant_list_hubs", arguments: { apiUrl: untrusted.url } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/configured Thalovant credential origin/);
    expect(configured.requests).toHaveLength(0);
    expect(untrusted.requests).toHaveLength(0);
  });

  it("binds a token without an explicit API URL to the default origin", async () => {
    const untrusted = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });
    const result = await client.callTool({ name: "thalovant_list_hubs", arguments: { apiUrl: untrusted.url } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/configured Thalovant credential origin/);
    expect(untrusted.requests).toHaveLength(0);
  });

  it("allows a normalized equivalent origin for an explicitly configured custom API", async () => {
    const configured = await startFakeControlPlane(undefined, { tls: true });
    const client = await connectStdioClient({ THALOVANT_API_URL: configured.url, THALOVANT_API_TOKEN: API_TOKEN, NODE_EXTRA_CA_CERTS: configured.ca! });
    const result = await client.callTool({ name: "thalovant_list_hubs", arguments: { apiUrl: configured.url.replace("https:", "HTTPS:") + "/" } });
    expect(result.isError).not.toBe(true);
    expect(configured.requests).toHaveLength(1);
    expect(configured.requests[0]?.authorization).toBe(`Bearer ${API_TOKEN}`);
  });

  it.each<Record<string, string>>([
    { THALOVANT_API_TOKEN: API_TOKEN },
    { THALOVANT_EMAIL: "synthetic@example.invalid", THALOVANT_PASSWORD: "synthetic-password" },
  ])("rejects credential-bearing arbitrary plaintext origins before API requests", async credentials => {
    const client = await connectStdioClient({ THALOVANT_API_URL: "http://custom.example.invalid", ...credentials });
    const result = await client.callTool({ name: "thalovant_list_hubs", arguments: {} });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("require HTTPS");
  });

  for (const status of [307, 308]) {
    for (const auth of ["bearer", "password"]) {
      it(`rejects ${status} redirects without forwarding ${auth} credentials`, async () => {
        const target = await startFakeControlPlane();
        const configured = await startFakeControlPlane(undefined, { redirect: { status, location: target.url } });
        const credentials: Record<string, string> = auth === "bearer" ? { THALOVANT_API_TOKEN: API_TOKEN } : { THALOVANT_EMAIL: "synthetic@example.invalid", THALOVANT_PASSWORD: "synthetic-password" };
        const client = await connectStdioClient({ THALOVANT_API_URL: configured.url, ...credentials });
        const result = await client.callTool({ name: "thalovant_list_hubs", arguments: {} });
        expect(result.isError).toBe(true);
        expect(configured.requests).toHaveLength(1);
        expect(target.requests).toHaveLength(0);
      });
    }
  }

  it("allows anonymous public discovery against a custom API without attaching credentials", async () => {
    const publicApi = await startFakeControlPlane();
    const client = await connectStdioClient({});
    const result = await client.callTool({ name: "thalovant_list_public_hubs", arguments: { apiUrl: publicApi.url } });
    expect(result.isError).not.toBe(true);
    expect(publicApi.requests).toHaveLength(1);
    expect(publicApi.requests[0]?.authorization).toBeUndefined();
  });
});

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
  it("saves a valid identity inside the configured directory with private permissions", async () => {
    const fake = await startFakeControlPlane({ id: "hub-1", domain: "hub.example" });
    const identityDir = await mkdtemp(join(tmpdir(), "mcp-identity-save-"));
    cleanups.push(() => rm(identityDir, { recursive: true, force: true }));
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_API_URL: fake.url,
      THALOVANT_MCP_IDENTITY_DIR: identityDir,
    });

    const result = await client.callTool({
      name: "thalovant_create_client_identity",
      arguments: { hubId: "hub-1", name: "edge", savePath: "my-hub.json" },
    });

    expect(result.isError ?? false, resultText(result)).toBe(false);
    const output = JSON.parse(resultText(result)) as { savedIdentityPath: string };
    const savedPath = join(identityDir, "my-hub.json");
    expect(output.savedIdentityPath).toBe(savedPath);
    const saved = JSON.parse(await readFile(savedPath, "utf8")) as Record<string, unknown>;
    const created = fake.requests.find(request => request.method === "POST" && request.path === "/v1/clients");
    expect(created).toBeDefined();
    const sentSpec = created!.body!.spec as Record<string, unknown>;
    expect(typeof sentSpec.apiKey).toBe("string");
    expect(typeof sentSpec.password).toBe("string");
    expect((sentSpec.apiKey as string).length).toBeGreaterThan(0);
    expect((sentSpec.password as string).length).toBeGreaterThan(0);
    expect(saved.access_key).toBe(sentSpec.apiKey);
    expect(saved.password).toBe(sentSpec.password);
    expect(resultText(result)).not.toContain(sentSpec.apiKey as string);
    expect(resultText(result)).not.toContain(String(sentSpec.password));
    if (process.platform !== "win32") expect((await stat(savedPath)).mode & 0o777).toBe(0o600);
  }, 15_000);

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
  it("validates routed-query inputs before acquiring a runtime identity", async () => {
    const client = await connectStdioClient({});
    for (const arguments_ of [
      { text: " " }, { text: "query", timeoutMs: 0 }, { text: "query", queryId: "" },
      { text: "query", requestId: "" }, { text: "query", sessionId: "" },
      { text: "query", lang: "" }, { text: "query", replySettleMs: -1 },
    ]) {
      const result = await client.callTool({ name: "thalovant_query", arguments: arguments_ });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/validation|invalid/i);
    }
  });

  it("hides write and destructive tools from tools/list when THALOVANT_MCP_READONLY is set", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_MCP_READONLY: "1" });

    const names = (await client.listTools()).tools.map((tool) => tool.name);

    // Read-only tools remain available.
    expect(names).toContain("thalovant_config_status");
    expect(names).toContain("thalovant_list_public_hubs");
    expect(names).toContain("thalovant_get_analytics_overview");

    // Write / destructive tools are not registered at all.
    expect(names).not.toContain("thalovant_query");
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
