import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

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
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toContain("thalovant_list_public_hubs");
      expect(toolNames).toContain("thalovant_ask");
      expect(toolNames).toContain("thalovant_create_client_identity");

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
});
