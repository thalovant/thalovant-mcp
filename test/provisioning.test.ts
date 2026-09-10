import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const API_TOKEN = "tvpat_provisioning-test-token";

interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
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

async function startFakeControlPlane(
  respond: (request: RecordedRequest, response: ServerResponse) => void = (request, response) => {
    response.end(JSON.stringify({ ok: true, path: request.path }));
  },
): Promise<FakeControlPlane> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | undefined;
      try {
        body = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : undefined;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Malformed JSON in test request" }));
        return;
      }
      const request: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value ?? "")]),
        ),
        body,
      };
      requests.push(request);
      res.setHeader("Content-Type", "application/json");
      respond(request, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake: FakeControlPlane = {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
  cleanups.push(fake.close);
  return fake;
}

interface FakeResponse {
  status?: number;
  body: unknown;
}

/** Optional per-request JSON responder; returning undefined keeps the default `{ ok: true, path }` reply. */
type FakeResponder = (request: RecordedRequest) => FakeResponse | undefined;

/** Adapts a JSON responder to the raw response hook of `startFakeControlPlane`. */
function jsonResponder(respond: FakeResponder): (request: RecordedRequest, response: ServerResponse) => void {
  return (request, response) => {
    const custom = respond(request);
    response.statusCode = custom?.status ?? 200;
    response.end(JSON.stringify(custom ? custom.body : { ok: true, path: request.path }));
  };
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
  const client = new Client({ name: "thalovant-mcp-provisioning", version: "0.0.0" }, { capabilities: {} });
  cleanups.push(() => client.close());
  await client.connect(transport);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  const tools = await client.listTools();
  return tools.tools.map((tool) => tool.name);
}

function resultText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

async function callToolSuccessfully(client: Client, request: Parameters<Client["callTool"]>[0]) {
  const result = await client.callTool(request);
  expect(result.isError ?? false, resultText(result)).toBe(false);
  return result;
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

const ENABLED_TOOLS = [
  "thalovant_list_marketplace_skills",
  "thalovant_list_runtime_group_marketplace",
  "thalovant_list_runtime_group_inventory",
  "thalovant_create_hub",
  "thalovant_update_hub",
  "thalovant_release_hub",
  "thalovant_list_runtime_groups",
  "thalovant_get_runtime_group",
  "thalovant_create_runtime_group",
  "thalovant_update_runtime_group",
  "thalovant_get_runtime_group_config",
  "thalovant_update_runtime_group_config",
  "thalovant_release_runtime_group",
  "thalovant_install_runtime_group_skill",
  "thalovant_uninstall_runtime_group_skill",
  "thalovant_set_hub_rating",
  "thalovant_clear_hub_rating",
  "thalovant_get_hub_runtime_capabilities",
  "thalovant_list_hub_skills",
  "thalovant_install_hub_skill",
  "thalovant_update_hub_skill",
  "thalovant_remove_hub_skill",
];

// Registered tool counts per mode. README and CHANGELOG quote these numbers.
const DEFAULT_TOOL_COUNT = 45;
const READ_ONLY_TOOL_COUNT = 22;
const DESTRUCTIVE_ENABLED_TOOL_COUNT = 47;

describe("provisioning and discovery tool registration", () => {
  it("registers every non-destructive provisioning and discovery tool by default", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });
    const names = await toolNames(client);
    for (const tool of ENABLED_TOOLS) {
      expect(names).toContain(tool);
    }
  }, 15_000);

  it("registers the documented number of tools in each mode", async () => {
    const byDefault = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });
    expect(await toolNames(byDefault)).toHaveLength(DEFAULT_TOOL_COUNT);

    const readOnly = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_MCP_READONLY: "1" });
    const readOnlyNames = await toolNames(readOnly);
    expect(readOnlyNames).toHaveLength(READ_ONLY_TOOL_COUNT);
    expect(readOnlyNames).toContain("thalovant_list_hub_skills");
    expect(readOnlyNames).not.toContain("thalovant_install_hub_skill");
    expect(readOnlyNames).not.toContain("thalovant_update_hub_skill");
    expect(readOnlyNames).not.toContain("thalovant_remove_hub_skill");

    const destructive = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "true" });
    expect(await toolNames(destructive)).toHaveLength(DESTRUCTIVE_ENABLED_TOOL_COUNT);
  }, 30_000);

  it("omits destructive tools from tools/list by default", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });
    const names = await toolNames(client);
    expect(names).not.toContain("thalovant_delete_hub");
    expect(names).not.toContain("thalovant_delete_runtime_group");

    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    expect(resultText(status)).toContain('"destructiveToolsEnabled": false');
  }, 15_000);

  it("registers destructive tools only when THALOVANT_ENABLE_DESTRUCTIVE_TOOLS is set", async () => {
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "true",
    });
    const names = await toolNames(client);
    expect(names).toContain("thalovant_delete_hub");
    expect(names).toContain("thalovant_delete_runtime_group");

    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    const text = resultText(status);
    expect(text).toContain('"destructiveToolsEnabled": true');
    expect(text).toContain("thalovant_delete_hub");
  }, 15_000);

  it("keeps destructive tools deniable by the existing tool policy once enabled", async () => {
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "true",
      MCP_TOOL_DENYLIST: "thalovant_delete_hub",
    });
    const denied = await client.callTool({
      name: "thalovant_delete_hub",
      arguments: { hubId: "hub-1", etag: "etag-1" },
    });
    expect(denied.isError).toBe(true);
    expect(resultText(denied)).toMatch(/disabled by server policy/i);
  }, 15_000);

  it("still redacts secrets in config status", async () => {
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN });
    const status = await client.callTool({ name: "thalovant_config_status", arguments: {} });
    const text = resultText(status);
    expect(text).toContain('"hasApiToken": true');
    expect(text).not.toContain(API_TOKEN);
  }, 15_000);
});

describe("provisioning tool delegation to the SDK", () => {
  it("creates a hub with an idempotency key and snake_case payload", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_create_hub",
      arguments: {
        name: "kitchen",
        spec: { version: "1", size: "small" },
        runtimeGroupId: "rg-1",
        capacityProfile: "autoscaling",
        idempotencyKey: "key-123",
      },
    });
    expect(result.isError ?? false).toBe(false);

    const request = findRequest(fake, "POST", "/v1/hubs");
    expect(request.headers["idempotency-key"]).toBe("key-123");
    expect(request.headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(request.body).toMatchObject({
      name: "kitchen",
      spec: { version: "1", size: "small" },
      runtime_group_id: "rg-1",
      capacity_profile: "autoscaling",
    });
  }, 15_000);

  it("sends the hub etag as If-Match on update and omits immutable fields", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_update_hub",
      arguments: { hubId: "hub-42", etag: 'W/"7"', active: false, capacityProfile: "standard" },
    });
    expect(result.isError ?? false).toBe(false);

    const request = findRequest(fake, "PATCH", "/v1/hubs/hub-42");
    expect(request.headers["if-match"]).toBe('W/"7"');
    expect(request.body).toMatchObject({ active: false, capacity_profile: "standard" });
    expect(request.body).not.toHaveProperty("etag");
    expect(request.body).not.toHaveProperty("hubId");
  }, 15_000);

  it("rejects an update without an etag before any request is made", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_update_hub", arguments: { hubId: "hub-42", active: false } });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("rejects a capacity profile outside the API's enum", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_create_hub",
      arguments: { name: "kitchen", spec: { version: "1" }, capacityProfile: "burstable" },
    });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("rejects a hub rating outside 1..5", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const tooHigh = await client.callTool({ name: "thalovant_set_hub_rating", arguments: { hubId: "hub-1", rating: 6 } });
    expect(tooHigh.isError).toBe(true);
    const tooLow = await client.callTool({ name: "thalovant_set_hub_rating", arguments: { hubId: "hub-1", rating: 0 } });
    expect(tooLow.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);

    const ok = await client.callTool({ name: "thalovant_set_hub_rating", arguments: { hubId: "hub-1", rating: 5 } });
    expect(ok.isError ?? false).toBe(false);
    const request = findRequest(fake, "PUT", "/v1/hubs/hub-1/rating");
    expect(request.body).toMatchObject({ rating: 5 });
  }, 15_000);

  it("clears a hub rating with DELETE", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    await callToolSuccessfully(client, { name: "thalovant_clear_hub_rating", arguments: { hubId: "hub-1" } });
    findRequest(fake, "DELETE", "/v1/hubs/hub-1/rating");
  }, 15_000);

  it("reads hub runtime capabilities", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    await callToolSuccessfully(client, { name: "thalovant_get_hub_runtime_capabilities", arguments: { hubId: "hub-9" } });
    findRequest(fake, "GET", "/v1/hubs/hub-9/runtime-capabilities");
  }, 15_000);

  it("applies release options to a hub", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    await callToolSuccessfully(client, {
      name: "thalovant_release_hub",
      arguments: { hubId: "hub-3", channel: "stable", reason: "pin" },
    });
    const request = findRequest(fake, "POST", "/v1/hubs/hub-3/release");
    expect(request.body).toMatchObject({ channel: "stable", reason: "pin" });
    expect(request.body).not.toHaveProperty("mode");
  }, 15_000);

  it("lists the marketplace catalog with force_refresh", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    await callToolSuccessfully(client, { name: "thalovant_list_marketplace_skills", arguments: { forceRefresh: true } });
    const request = findRequest(fake, "GET", "/v1/marketplace/skills");
    expect(request.query.force_refresh).toBe("true");
  }, 15_000);

  it("lists the runtime-group marketplace and inventory views", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    await callToolSuccessfully(client, {
      name: "thalovant_list_runtime_group_marketplace",
      arguments: { runtimeGroupId: "rg-1", refreshInventory: true },
    });
    expect(findRequest(fake, "GET", "/v1/runtime-groups/rg-1/marketplace").query.refresh_inventory).toBe("true");

    await callToolSuccessfully(client, {
      name: "thalovant_list_runtime_group_inventory",
      arguments: { runtimeGroupId: "rg-1", refresh: true },
    });
    expect(findRequest(fake, "GET", "/v1/runtime-groups/rg-1/inventory").query.refresh).toBe("true");
  }, 15_000);

  it("creates, reads, and updates runtime groups and their config", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    await callToolSuccessfully(client, { name: "thalovant_list_runtime_groups", arguments: {} });
    findRequest(fake, "GET", "/v1/runtime-groups");

    await callToolSuccessfully(client, { name: "thalovant_get_runtime_group", arguments: { runtimeGroupId: "rg-2" } });
    findRequest(fake, "GET", "/v1/runtime-groups/rg-2");

    await callToolSuccessfully(client, {
      name: "thalovant_create_runtime_group",
      arguments: { name: "edge", cloneFromDefault: true },
    });
    expect(findRequest(fake, "POST", "/v1/runtime-groups").body).toMatchObject({ name: "edge", clone_from_default: true });

    await callToolSuccessfully(client, {
      name: "thalovant_update_runtime_group",
      arguments: { runtimeGroupId: "rg-2", description: "edge group" },
    });
    const patch = findRequest(fake, "PATCH", "/v1/runtime-groups/rg-2");
    expect(patch.body).toMatchObject({ description: "edge group" });
    expect(patch.headers["if-match"]).toBeUndefined();

    await callToolSuccessfully(client, { name: "thalovant_get_runtime_group_config", arguments: { runtimeGroupId: "rg-2" } });
    findRequest(fake, "GET", "/v1/runtime-groups/rg-2/config");

    await callToolSuccessfully(client, {
      name: "thalovant_update_runtime_group_config",
      arguments: { runtimeGroupId: "rg-2", config: { tts: "piper" }, personas: { default: "helpful" } },
    });
    const configPatch = findRequest(fake, "PATCH", "/v1/runtime-groups/rg-2/config");
    expect(configPatch.body).toMatchObject({ config: { tts: "piper" }, personas: { default: "helpful" } });

    await callToolSuccessfully(client, {
      name: "thalovant_release_runtime_group",
      arguments: { runtimeGroupId: "rg-2", version: "1.2.3" },
    });
    expect(findRequest(fake, "POST", "/v1/runtime-groups/rg-2/release").body).toMatchObject({ version: "1.2.3" });
  }, 20_000);

  it("installs a skill with the catalog defaults the API expects", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    await callToolSuccessfully(client, {
      name: "thalovant_install_runtime_group_skill",
      arguments: { runtimeGroupId: "rg-1", skillId: "skill-news" },
    });
    const request = findRequest(fake, "POST", "/v1/runtime-groups/rg-1/skills");
    expect(request.body).toMatchObject({ skill_id: "skill-news", source_type: "catalog", active: true });
  }, 15_000);

  it("installs a git-sourced skill with source_ref and version_pin", async () => {
    const fake = await startFakeControlPlane();
    // Git sources are gated: an operator must opt in with THALOVANT_ENABLE_GIT_SKILL_SOURCES.
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_API_URL: fake.url,
      THALOVANT_ENABLE_GIT_SKILL_SOURCES: "true",
    });

    await callToolSuccessfully(client, {
      name: "thalovant_install_runtime_group_skill",
      arguments: {
        runtimeGroupId: "rg-1",
        skillId: "skill-custom",
        sourceType: "git",
        sourceRef: "https://example.com/skill.git",
        versionPin: "v1.0.0",
        marketplaceSkillId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        active: false,
      },
    });
    expect(findRequest(fake, "POST", "/v1/runtime-groups/rg-1/skills").body).toMatchObject({
      skill_id: "skill-custom",
      source_type: "git",
      source_ref: "https://example.com/skill.git",
      version_pin: "v1.0.0",
      marketplace_skill_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      active: false,
    });
  }, 15_000);

  it("rejects a marketplace skill id that is not a UUID", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: { runtimeGroupId: "rg-1", skillId: "skill-news", marketplaceSkillId: "mk-1" },
    });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("passes through a source type the API accepts but does not special-case, once non-catalog sources are enabled", async () => {
    const fake = await startFakeControlPlane();
    // The API models source_type as a free-form 1..32 string, not an enum, so once
    // non-catalog sources are enabled the tool must not reject a value it does not
    // recognize.
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_API_URL: fake.url,
      THALOVANT_ENABLE_GIT_SKILL_SOURCES: "true",
    });

    const result = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: { runtimeGroupId: "rg-1", skillId: "skill-news", sourceType: "package" },
    });
    expect(result.isError ?? false).toBe(false);
    expect(findRequest(fake, "POST", "/v1/runtime-groups/rg-1/skills").body).toMatchObject({ source_type: "package" });
  }, 15_000);

  it("rejects a skill install payload that breaks the API's length bounds", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: { runtimeGroupId: "rg-1", skillId: "s".repeat(192) },
    });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("rejects a hub spec without the required version field", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_create_hub",
      arguments: { name: "kitchen", spec: { settings: {} } },
    });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("rejects a hub slug that breaks the API's pattern", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_create_hub",
      arguments: { name: "kitchen", spec: { version: "1" }, slug: "Not_A_Slug" },
    });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("rejects a runtime group spec replica count above the API's ceiling", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_update_runtime_group",
      arguments: { runtimeGroupId: "rg-1", spec: { replicas: 21 } },
    });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("uninstalls a skill by path", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    await callToolSuccessfully(client, {
      name: "thalovant_uninstall_runtime_group_skill",
      arguments: { runtimeGroupId: "rg-1", skillId: "skill-news" },
    });
    findRequest(fake, "DELETE", "/v1/runtime-groups/rg-1/skills/skill-news");
  }, 15_000);

  it("sends the hub etag as If-Match on delete when destructive tools are enabled", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({
      THALOVANT_API_TOKEN: API_TOKEN,
      THALOVANT_API_URL: fake.url,
      THALOVANT_ENABLE_DESTRUCTIVE_TOOLS: "true",
    });

    await callToolSuccessfully(client, { name: "thalovant_delete_hub", arguments: { hubId: "hub-42", etag: 'W/"9"' } });
    expect(findRequest(fake, "DELETE", "/v1/hubs/hub-42").headers["if-match"]).toBe('W/"9"');

    await callToolSuccessfully(client, { name: "thalovant_delete_runtime_group", arguments: { runtimeGroupId: "rg-5" } });
    findRequest(fake, "DELETE", "/v1/runtime-groups/rg-5");
  }, 15_000);

  it("requires control-plane auth for provisioning tools", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_create_hub", arguments: { name: "kitchen", spec: { version: "1" } } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("THALOVANT_API_TOKEN");
    expect(fake.requests).toHaveLength(0);
  }, 15_000);
});

describe("hub skill tools", () => {
  const HUB_SKILL_WRITE = /^\/v1\/hubs\/[^/]+\/skills(?:\/[^/]+)?$/;

  /** Answers hub-skill writes with a 202 operation and the operation route with a scripted status sequence. */
  function hubSkillResponder(statuses: string[], operation: Partial<Record<string, unknown>> = {}): FakeResponder {
    let polls = 0;
    return (request) => {
      if (request.method !== "GET" && HUB_SKILL_WRITE.test(request.path)) {
        const state = request.method === "POST" ? "installing" : request.method === "PATCH" ? "updating" : "removing";
        const skill = request.method === "POST" ? request.body?.skill : decodeURIComponent(request.path.split("/").pop() ?? "");
        return {
          status: 202,
          body: {
            operation_id: "op-1",
            hub_id: "hub-1",
            runtime_group_id: "rg-1",
            skill,
            version: request.method === "DELETE" ? null : (request.body?.version ?? null),
            previous_version: request.method === "POST" ? null : "1.1.0",
            state,
          },
        };
      }
      if (request.method === "GET" && request.path === "/v1/operations/op-1") {
        const status = statuses[Math.min(polls, statuses.length - 1)];
        polls += 1;
        return { body: { id: "op-1", kind: "hub.skill", status, error_code: null, error_message: null, ...operation } };
      }
      return undefined;
    };
  }

  const HUB_SKILL_ROW = {
    skill: "skill-weather",
    title: "Weather",
    marketplace_skill_id: "mk-1",
    package_name: "thalovant-skill-weather",
    source_type: "marketplace",
    install_source: "pypi",
    version: "1.1.0",
    version_pin: "1.1.0",
    installed_version: "1.1.0",
    observed_version: "1.1.0",
    previous_version: null,
    latest_version: "1.2.0",
    available_version: "1.2.0",
    update_available: true,
    changelog: "Adds hourly forecasts.",
    active: true,
    state: "installed",
    operator_phase: "Ready",
    operator_message: null,
    operator_last_error: null,
    last_transition_at: "2026-09-09T10:00:00Z",
  };

  const HUB_SKILL_LIST = {
    hub_id: "hub-1",
    runtime_group_id: "rg-1",
    observed_at: "2026-09-09T10:00:05Z",
    source: "runtime",
    operator_phase: "Ready",
    operator_message: null,
    data: [HUB_SKILL_ROW],
  };

  it("lists the skills of one hub with the bearer token and returns the whole envelope", async () => {
    const fake = await startFakeControlPlane(jsonResponder((request) => (request.path === "/v1/hubs/hub-1/skills" ? { body: HUB_SKILL_LIST } : undefined)));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_list_hub_skills", arguments: { hubId: "hub-1" } });
    expect(result.isError ?? false).toBe(false);
    const request = findRequest(fake, "GET", "/v1/hubs/hub-1/skills");
    expect(request.headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(request.headers.accept).toBe("application/json");
    expect(request.headers["user-agent"]).toMatch(/^thalovant-mcp\//);
    expect(JSON.parse(resultText(result))).toEqual(HUB_SKILL_LIST);
  }, 15_000);

  it("returns an empty data array for a hub with no skills", async () => {
    const fake = await startFakeControlPlane(jsonResponder((request) =>
      request.path === "/v1/hubs/hub-1/skills" ? { body: { ...HUB_SKILL_LIST, observed_at: null, data: [] } } : undefined,
    ));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_list_hub_skills", arguments: { hubId: "hub-1" } });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(resultText(result))).toMatchObject({ hub_id: "hub-1", runtime_group_id: "rg-1", observed_at: null, data: [] });
  }, 15_000);

  it("rejects a list body without a data array", async () => {
    const fake = await startFakeControlPlane(jsonResponder((request) =>
      request.path === "/v1/hubs/hub-1/skills" ? { body: { hub_id: "hub-1", items: [HUB_SKILL_ROW] } } : undefined,
    ));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_list_hub_skills", arguments: { hubId: "hub-1" } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("unexpected hub skill list shape");
  }, 15_000);

  it("installs with the default latest version and returns the accepted operation without waiting", async () => {
    const fake = await startFakeControlPlane(jsonResponder(hubSkillResponder(["ready"])));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_install_hub_skill", arguments: { hubId: "hub-1", skill: "skill-weather" } });
    expect(result.isError ?? false).toBe(false);
    const request = findRequest(fake, "POST", "/v1/hubs/hub-1/skills");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body).toEqual({ skill: "skill-weather", version: "latest" });
    expect(JSON.parse(resultText(result))).toEqual({
      operation_id: "op-1",
      hub_id: "hub-1",
      runtime_group_id: "rg-1",
      skill: "skill-weather",
      version: "latest",
      previous_version: null,
      state: "installing",
      operation: null,
    });
    expect(fake.requests.some((entry) => entry.path.startsWith("/v1/operations/"))).toBe(false);
  }, 15_000);

  it("updates a hub skill to an explicit version with PATCH", async () => {
    const fake = await startFakeControlPlane(jsonResponder(hubSkillResponder(["ready"])));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_update_hub_skill",
      arguments: { hubId: "hub-1", skill: "skill-weather", version: "1.2.0" },
    });
    expect(result.isError ?? false).toBe(false);
    expect(findRequest(fake, "PATCH", "/v1/hubs/hub-1/skills/skill-weather").body).toEqual({ version: "1.2.0" });
    expect(JSON.parse(resultText(result))).toMatchObject({ state: "updating", version: "1.2.0", previous_version: "1.1.0", hub_id: "hub-1", runtime_group_id: "rg-1" });
  }, 15_000);

  it("requires a version on update before any request is made", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_update_hub_skill", arguments: { hubId: "hub-1", skill: "skill-weather" } });
    expect(result.isError).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }, 15_000);

  it("removes a hub skill with DELETE and no body", async () => {
    const fake = await startFakeControlPlane(jsonResponder(hubSkillResponder(["ready"])));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_remove_hub_skill", arguments: { hubId: "hub-1", skill: "skill-weather" } });
    expect(result.isError ?? false).toBe(false);
    const request = findRequest(fake, "DELETE", "/v1/hubs/hub-1/skills/skill-weather");
    expect(request.body).toBeUndefined();
    expect(request.headers["content-type"]).toBeUndefined();
    expect(JSON.parse(resultText(result))).toMatchObject({ operation_id: "op-1", state: "removing", version: null, previous_version: "1.1.0", hub_id: "hub-1" });
  }, 15_000);

  it("polls the operation until ready when wait is true", async () => {
    const fake = await startFakeControlPlane(jsonResponder(hubSkillResponder(["requested", "ready"])));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_install_hub_skill",
      arguments: { hubId: "hub-1", skill: "skill-weather", version: "1.2.0", wait: true },
    });
    expect(result.isError ?? false).toBe(false);
    const polls = fake.requests.filter((entry) => entry.method === "GET" && entry.path === "/v1/operations/op-1");
    expect(polls).toHaveLength(2);
    expect(polls[0]?.headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    const parsed = JSON.parse(resultText(result));
    expect(parsed).toMatchObject({ operation_id: "op-1", skill: "skill-weather", version: "1.2.0", state: "installed" });
    expect(parsed.operation).toMatchObject({ id: "op-1", status: "ready" });
  }, 20_000);

  it("reports removed when a waited removal converges", async () => {
    const fake = await startFakeControlPlane(jsonResponder(hubSkillResponder(["ready"])));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_remove_hub_skill",
      arguments: { hubId: "hub-1", skill: "skill-weather", wait: true },
    });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(resultText(result))).toMatchObject({ state: "removed", operation: { status: "ready" } });
  }, 15_000);

  it("surfaces the operation error_message when a waited operation fails", async () => {
    const fake = await startFakeControlPlane(
      jsonResponder(hubSkillResponder(["failed"], { error_code: "SKILL_INSTALL_FAILED", error_message: "pip could not resolve skill-weather==9.9.9" })),
    );
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_install_hub_skill",
      arguments: { hubId: "hub-1", skill: "skill-weather", version: "9.9.9", wait: true },
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("op-1");
    expect(text).toContain("failed");
    expect(text).toContain("pip could not resolve skill-weather==9.9.9");
  }, 15_000);

  it("URL-encodes the skill name in the path", async () => {
    const fake = await startFakeControlPlane(jsonResponder(hubSkillResponder(["ready"])));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    await client.callTool({ name: "thalovant_remove_hub_skill", arguments: { hubId: "hub-1", skill: "skill/weather v2" } });
    findRequest(fake, "DELETE", "/v1/hubs/hub-1/skills/skill%2Fweather%20v2");
    await client.callTool({ name: "thalovant_update_hub_skill", arguments: { hubId: "hub-1", skill: "skill/weather v2", version: "2.0.0" } });
    findRequest(fake, "PATCH", "/v1/hubs/hub-1/skills/skill%2Fweather%20v2");
  }, 15_000);

  it("surfaces the 409 problem code after the message, without echoing the body, and explains it as already at that version", async () => {
    const fake = await startFakeControlPlane(jsonResponder((request) =>
      request.method === "POST" && request.path === "/v1/hubs/hub-1/skills"
        ? {
            status: 409,
            body: {
              type: "about:blank",
              title: "Conflict",
              status: 409,
              code: "skill_version_already_installed",
              message: "Skill version already installed.",
              echoed_secret: "tvpat_should-not-leak",
            },
          }
        : undefined,
    ));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_install_hub_skill", arguments: { hubId: "hub-1", skill: "skill-weather", version: "1.1.0" } });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("Thalovant API request failed with HTTP 409: Skill version already installed. (skill_version_already_installed)");
    expect(text).toContain("thalovant_update_hub_skill");
    expect(text).toMatch(/DIFFERENT version performs an update/);
    expect(text).not.toContain("tvpat_should-not-leak");
  }, 15_000);

  it("surfaces the 404 hub_without_runtime_group code and explains it", async () => {
    const fake = await startFakeControlPlane(jsonResponder((request) =>
      request.path === "/v1/hubs/hub-1/skills"
        ? { status: 404, body: { type: "about:blank", title: "Not Found", status: 404, code: "hub_without_runtime_group", message: "Hub has no runtime group." } }
        : undefined,
    ));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_list_hub_skills", arguments: { hubId: "hub-1" } });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("HTTP 404: Hub has no runtime group. (hub_without_runtime_group)");
    expect(text).toContain("thalovant_update_hub");
  }, 15_000);

  it("leaves a plain 404 (unknown hub or skill not installed) without a code or hint", async () => {
    const fake = await startFakeControlPlane(jsonResponder((request) =>
      request.method === "DELETE" ? { status: 404, body: { type: "about:blank", title: "Not Found", status: 404, message: "Skill not installed." } } : undefined,
    ));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_remove_hub_skill", arguments: { hubId: "hub-1", skill: "skill-weather" } });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("HTTP 404: Skill not installed.");
    expect(text).not.toContain("hub_without_runtime_group");
  }, 15_000);

  it("explains a 422 on install as an unresolvable latest or invalid version", async () => {
    const fake = await startFakeControlPlane(jsonResponder((request) =>
      request.method === "POST" ? { status: 422, body: { type: "about:blank", title: "Unprocessable Entity", status: 422, message: "Version 'banana' is not a valid version." } } : undefined,
    ));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_install_hub_skill", arguments: { hubId: "hub-1", skill: "skill-weather", version: "banana" } });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("HTTP 422: Version 'banana' is not a valid version.");
    expect(text).toMatch(/could not be resolved to a published version/);
  }, 15_000);

  it("requires control-plane auth for hub skill tools", async () => {
    const fake = await startFakeControlPlane();
    const client = await connectStdioClient({ THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_list_hub_skills", arguments: { hubId: "hub-1" } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("THALOVANT_API_TOKEN");
    expect(fake.requests).toHaveLength(0);
  }, 15_000);
});

describe("control-plane error guidance", () => {
  async function startFailingControlPlane(status: number, body: string): Promise<FakeControlPlane> {
    return startFakeControlPlane((_request, response) => {
      response.statusCode = status;
      response.end(body);
    });
  }

  it("explains a 412 as a stale or missing etag", async () => {
    const fake = await startFailingControlPlane(412, JSON.stringify({ detail: "precondition failed" }));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_update_hub",
      arguments: { hubId: "hub-1", etag: "stale", active: true },
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("412");
    expect(text).toContain("thalovant_get_hub");
  }, 15_000);

  it("explains a 403 as a missing scope that can mask the plan gate", async () => {
    const fake = await startFailingControlPlane(403, JSON.stringify({ detail: "forbidden" }));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_create_hub", arguments: { name: "kitchen", spec: { version: "1" } } });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("hubs:write");
    expect(text).toMatch(/before the paid-plan gate/i);
  }, 15_000);

  it("explains the plan-gate 402 on provisioning", async () => {
    const fake = await startFailingControlPlane(402, JSON.stringify({ detail: "API access requires a paid plan" }));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({ name: "thalovant_create_hub", arguments: { name: "kitchen", spec: { version: "1" } } });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("API access requires a paid plan");
  }, 15_000);

  it("distinguishes the marketplace 402 at skill install from the plan-gate 402", async () => {
    const fake = await startFailingControlPlane(402, JSON.stringify({ detail: "This skill requires paid marketplace access" }));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_install_runtime_group_skill",
      arguments: { runtimeGroupId: "rg-1", skillId: "skill-paid" },
    });
    expect(result.isError).toBe(true);
    const text = resultText(result);
    expect(text).toMatch(/DIFFERENT 402/);
    expect(text).toContain("purchase_required");
  }, 15_000);

  it("explains a 409 on create as idempotency-key reuse", async () => {
    const fake = await startFailingControlPlane(409, JSON.stringify({ detail: "conflict" }));
    const client = await connectStdioClient({ THALOVANT_API_TOKEN: API_TOKEN, THALOVANT_API_URL: fake.url });

    const result = await client.callTool({
      name: "thalovant_create_hub",
      arguments: { name: "kitchen", spec: { version: "1" }, idempotencyKey: "key-1" },
    });
    const text = resultText(result);
    expect(text).toMatch(/Idempotency key re-used with different payload/i);
    expect(text).toContain("idempotencyKey");
  }, 15_000);
});


it("reads an asynchronous operation without replaying the provisioning write", async () => {
  const fake = await startFakeControlPlane();
  const client = await connectStdioClient({ THALOVANT_API_URL: fake.url, THALOVANT_API_TOKEN: "synthetic-operation-token" });
  const result = await client.callTool({ name: "thalovant_get_operation", arguments: { operationId: "op-fixture" } });
  expect(result.isError).not.toBe(true);
  expect(fake.requests).toHaveLength(1);
  const request = findRequest(fake, "GET", "/v1/operations/op-fixture");
  expect(request.headers.authorization).toBe("Bearer synthetic-operation-token");
});
