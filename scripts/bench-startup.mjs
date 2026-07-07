import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { performance } from "node:perf_hooks";

const runs = Number.parseInt(process.env.BENCH_RUNS ?? "5", 10);
const durations = [];

for (let i = 0; i < runs; i += 1) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: process.env,
  });
  const client = new Client(
    { name: "thalovant-mcp-bench", version: "0.0.0" },
    { capabilities: {} },
  );
  const start = performance.now();
  await client.connect(transport);
  await client.listTools();
  durations.push(performance.now() - start);
  await client.close();
}

const sorted = durations.toSorted((a, b) => a - b);
const sum = durations.reduce((total, value) => total + value, 0);
const result = {
  runs,
  minMs: Number(sorted[0]?.toFixed(2)),
  medianMs: Number(sorted[Math.floor(sorted.length / 2)]?.toFixed(2)),
  maxMs: Number(sorted.at(-1)?.toFixed(2)),
  meanMs: Number((sum / durations.length).toFixed(2)),
};

console.error(JSON.stringify(result, null, 2));
