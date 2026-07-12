import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";

import { publishBenchmark, summarizeDurations } from "./bench-report.mjs";

const runs = Number.parseInt(process.env.BENCH_RUNS ?? "5", 10);
const maxP95Ms = Number(process.env.BENCH_MAX_P95_MS ?? "2000");
const port = await freePort();
const token = randomBytes(24).toString("hex");
const child = spawn(process.execPath, ["dist/index.js", "--http"], {
  env: {
    ...process.env,
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_HTTP_AUTH_TOKEN: token,
    MCP_HTTP_ALLOWED_HOSTS: `127.0.0.1:${port},localhost:${port}`,
    MCP_HTTP_RATE_LIMIT_MAX: "10000",
  },
  stdio: ["ignore", "ignore", "pipe"],
});

try {
  await waitForHealth(port);
  const durations = [];
  for (let i = 0; i < runs; i += 1) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    const client = new Client({ name: "thalovant-mcp-http-bench", version: "0.0.0" }, { capabilities: {} });
    const start = performance.now();
    await client.connect(transport);
    await client.listTools();
    durations.push(performance.now() - start);
    await client.close();
  }

  await publishBenchmark({
    schemaVersion: 1,
    transport: "streamable-http",
    ...summarizeDurations(durations, maxP95Ms),
  });
} finally {
  await stopChild(child);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate benchmark port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForHealth(port) {
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

async function stopChild(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  childProcess.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      childProcess.kill("SIGKILL");
      resolve();
    }, 2_000);
    childProcess.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
