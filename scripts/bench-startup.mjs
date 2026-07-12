import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { performance } from "node:perf_hooks";

import { publishBenchmark, summarizeDurations } from "./bench-report.mjs";

const runs = Number.parseInt(process.env.BENCH_RUNS ?? "5", 10);
const maxP95Ms = Number(process.env.BENCH_MAX_P95_MS ?? "2000");
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

const result = {
  schemaVersion: 1,
  transport: "stdio",
  ...summarizeDurations(durations, maxP95Ms),
};

await publishBenchmark(result);
