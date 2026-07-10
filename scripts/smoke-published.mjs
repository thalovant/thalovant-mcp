import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [mode, target, token] = process.argv.slice(2);

if (!mode || !target) {
  throw new Error("usage: node scripts/smoke-published.mjs <stdio|http> <command-or-url> [token]");
}

const client = new Client(
  { name: "thalovant-published-artifact-smoke", version: "0.0.0" },
  { capabilities: {} },
);

const transport =
  mode === "stdio"
    ? new StdioClientTransport({ command: target, args: ["--stdio"], env: process.env })
    : mode === "http"
      ? new StreamableHTTPClientTransport(new URL(target), {
          requestInit: { headers: { Authorization: `Bearer ${token ?? ""}` } },
        })
      : null;

if (!transport) {
  throw new Error(`unsupported smoke mode: ${mode}`);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of ["thalovant_config_status", "thalovant_list_public_hubs", "thalovant_ask"]) {
    if (!names.has(required)) {
      throw new Error(`${mode} published artifact is missing ${required}`);
    }
  }
  console.log(`verified ${mode} published artifact with ${names.size} tools`);
} finally {
  await client.close();
}
