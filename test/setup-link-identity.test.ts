import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// What the API's identify payload carried, and what a setup-link claim writes
// to identity.json unchanged: the master URL and no data-plane endpoints. This
// server dials WSS unless told otherwise, so it depends on @thalovant/sdk
// reading a wss:// master as the WSS endpoint (the reference's 3f37b7453397).
const setupLink = (master: string) => ({
  access_key: "client-access-key",
  password: "client-password",
  site_id: "stronghold",
  default_master: master,
  default_port: 443,
});

it("runs a setup-link identity over the default WSS transport, and refuses an https:// master", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-mcp-setup-link-"));
  let mcp: Client | undefined;
  try {
    const wss = join(directory, "wss-identity.json");
    const https = join(directory, "https-identity.json");
    await writeFile(wss, JSON.stringify(setupLink("wss://daily-desk.thalovant.io")), { mode: 0o600 });
    await writeFile(https, JSON.stringify(setupLink("https://daily-desk.thalovant.io")), { mode: 0o600 });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith("THALOVANT_") || key.startsWith("MCP_")) continue;
      env[key] = value;
    }
    env.XDG_CONFIG_HOME = join(directory, "config");
    mcp = new Client({ name: "setup-link-identity", version: "0.0.0" });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env }));

    // No protocol argument: the tool's default, WSS. No connection is made.
    const status = await mcp.callTool({ name: "thalovant_identity_status", arguments: { identityFile: wss } });
    expect(status.isError).not.toBe(true);
    const text = (status.content as Array<{ type: string; text: string }>).find(item => item.type === "text")!.text;
    const body = JSON.parse(text);
    expect(body.supportsRequestedProtocol).toBe(true);
    expect(body.enabledProtocols).toEqual(["wss"]);
    expect(body.health.connected).toBe(false);

    // An https:// master names no WSS endpoint, so the default transport cannot be built.
    const refused = await mcp.callTool({ name: "thalovant_identity_status", arguments: { identityFile: https } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/WSS endpoint/);
  } finally {
    await mcp?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
