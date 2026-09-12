import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("stdio MCP server", () => {
  it("starts, lists tools, and returns redacted config status", async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: {
        ...process.env,
        THALOVANT_ACCESS_TOKEN: "secret-test-token",
      },
    });

    const client = new Client(
      {
        name: "thalovant-mcp-smoke",
        version: "0.0.0",
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport);
      const manifest = JSON.parse(await readFile("package.json", "utf8"));
      const registry = JSON.parse(await readFile("server.json", "utf8"));
      expect(client.getServerVersion()?.version).toBe(manifest.version);
      expect(registry.version).toBe(manifest.version);
      expect(registry.packages[0].version).toBe(manifest.version);
      expect(registry.packages[1].identifier).toMatch(new RegExp(`:${manifest.version.replaceAll(".", "\\.")}$`));
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toContain("thalovant_list_public_hubs");
      expect(toolNames).toContain("thalovant_ask");
      expect(toolNames).toContain("thalovant_query");
      expect(toolNames).toContain("thalovant_intent_inventory");
      expect(toolNames).toContain("thalovant_get_operation");
      expect(toolNames).toContain("thalovant_create_client_identity");
      const requiredInputs = {
        thalovant_ask: ["sttLang", "pipeline", "location", "includeAudio"],
        thalovant_query: ["includeAudio"],
        thalovant_intent_inventory: ["speakable", "sentence", "slots", "exampleLimit"],
        thalovant_update_runtime_group_config: ["merge"],
      };
      for (const [name, fields] of Object.entries(requiredInputs)) {
        const properties = tools.tools.find((tool) => tool.name === name)?.inputSchema.properties;
        for (const field of fields) expect(properties, `${name}.${field}`).toHaveProperty(field);
      }

      const result = await client.callTool({
        name: "thalovant_config_status",
        arguments: {},
      });
      expect(result.content).toHaveLength(1);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain('"hasAccessToken": true');
      expect(text).not.toContain("secret-test-token");
    } finally {
      await client.close();
    }
  }, 15_000);

  it("starts through an npm-style bin symlink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thalovant-mcp-bin-"));
    tempDirs.push(dir);
    const binPath = join(dir, "thalovant-mcp");
    await symlink(resolve("dist/index.js"), binPath);

    const transport = new StdioClientTransport({
      command: binPath,
      args: ["--stdio"],
      env: process.env,
    });
    const client = new Client({ name: "thalovant-mcp-bin-smoke", version: "0.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("thalovant_config_status");
    } finally {
      await client.close();
    }
  }, 15_000);
});
