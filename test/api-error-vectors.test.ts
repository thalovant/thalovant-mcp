/**
 * What a failed control-plane call tells a model, against the shared vectors.
 *
 * `api-error-vectors.json` is the reference's: thirteen responses the API
 * sends, from a platform_image_required 403 whose sentence is longer than any
 * SDK's message line to a body that is HTML, empty, or JSON that is not an
 * object. Two things are checked for each:
 *
 * - the `@thalovant/sdk` that resolves here reads the error as the vectors say
 *   (status, code, whole detail, whole body), recorded before it is asserted,
 *   because this server reads nothing from the body itself; and
 * - a real tool call, over stdio against the built server, surfaces the code,
 *   the whole sentence and every other field of the body in its result text,
 *   and never a value the body echoed back from the request.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ThalovantApiError, ThalovantControlPlane } from "@thalovant/sdk";
import { afterAll, beforeAll, describe, test } from "vitest";

import { apiErrorText } from "../src/api-error-output.js";
import { record } from "./conformance-record.js";

interface VectorResponse {
  status: number;
  content_type: string;
  body: string;
}

interface VectorCase {
  name: string;
  response: VectorResponse;
  expect: { status: number; code: string | null; detail: string | null; problem: Record<string, unknown> | null };
  message_excludes?: string[];
}

const vectors = (name: string) =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));

const spec: { cases: VectorCase[] } = vectors("api-error-vectors.json");

/** A loopback API that answers every request with whatever `current` is. */
let current: VectorResponse = spec.cases[0].response;
let server: Server;
let apiUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const body = Buffer.from(current.body, "utf8");
      response.writeHead(current.status, { "Content-Type": current.content_type, "Content-Length": body.length });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

async function refusal(response: VectorResponse): Promise<ThalovantApiError> {
  current = response;
  const api = new ThalovantControlPlane(apiUrl, { accessToken: "tvpat_api-error-vectors" });
  try {
    await api.getHub("hub-1");
  } catch (error) {
    assert.ok(error instanceof ThalovantApiError, String(error));
    return error;
  }
  assert.fail("the API refused and getHub() returned");
}

/** Whitespace-collapsed, the way the one-line message spells a sentence. */
const collapsed = (text: string) => text.replace(/\s+/g, " ").trim();

describe("the SDK under this server reads an API error as the vectors say", () => {
  for (const one of spec.cases) {
    test(one.name, async () => {
      const error = await refusal(one.response);
      const produced = {
        status: error.statusCode ?? null,
        code: error.code ?? null,
        detail: error.detail ?? null,
        problem: error.problem ?? null,
      };
      // Recorded before the assert: what the SDK produced, not a restatement
      // of what the vector says it should have.
      record("api-error-vectors.json", one.name, produced);
      assert.deepEqual(produced, one.expect);
    });
  }
});

describe("a tool call surfaces what the API said", () => {
  let client: Client;

  beforeAll(async () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith("THALOVANT_") || key.startsWith("MCP_")) continue;
      env[key] = value;
    }
    client = new Client({ name: "thalovant-mcp-api-errors", version: "0.0.0" }, { capabilities: {} });
    await client.connect(new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: { ...env, THALOVANT_API_URL: apiUrl, THALOVANT_API_TOKEN: "tvpat_api-error-vectors" },
    }));
  }, 15_000);

  afterAll(async () => {
    await client?.close();
  });

  for (const one of spec.cases) {
    test(one.name, async () => {
      current = one.response;
      const result = await client.callTool({ name: "thalovant_get_hub", arguments: { hubId: "hub-1" } });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
      assert.equal(result.isError, true, text);
      assert.match(text, new RegExp(`HTTP ${one.expect.status}\\b`));
      if (one.expect.code) assert.ok(text.includes(`code: ${one.expect.code}`), text);
      if (one.expect.detail) assert.ok(collapsed(text).includes(collapsed(one.expect.detail)), text);
      for (const [key, value] of Object.entries(one.expect.problem ?? {})) {
        if (["type", "title", "status", "instance"].includes(key)) continue;
        if ((key === "code" || key === "detail") && typeof value === "string") continue;
        assert.ok(text.includes(`"${key}":`), `${key} is missing from: ${text}`);
      }
      for (const echoed of one.message_excludes ?? []) {
        assert.ok(!text.includes(echoed), `the tool result repeated ${echoed}`);
      }
    }, 15_000);
  }

  test("a refused custom image lists every image the model may pin instead", async () => {
    const one = spec.cases.find((entry) => entry.expect.code === "platform_image_required")!;
    current = one.response;
    const result = await client.callTool({
      name: "thalovant_release_runtime_group",
      arguments: { runtimeGroupId: "rg-1", images: { core: "docker.io/example/ovos-core:custom" } },
    });
    const text = (result.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");
    assert.equal(result.isError, true, text);
    const problem = one.expect.problem as {
      allowed_images: Record<string, string[]>;
      allowed_repositories: Record<string, string>;
    };
    for (const image of Object.values(problem.allowed_images).flat()) assert.ok(text.includes(image), image);
    for (const repository of Object.values(problem.allowed_repositories)) assert.ok(text.includes(repository), repository);
    // The hint follows what the API said, and it is not the scope hint: this
    // 403 names its reason, and granting a scope would not change it.
    assert.ok(text.indexOf("allowed_images") < text.indexOf("only a platform administrator can run"), text);
    assert.ok(!text.includes("Insufficient scopes"), text);
  }, 15_000);
});

test("anything that is not an API error is left to its own message", () => {
  assert.equal(apiErrorText(new Error("The request was cancelled."), (value) => value), undefined);
  const plain = new ThalovantApiError("Missing Thalovant API access token.");
  assert.equal(apiErrorText(plain, (value) => value), "Missing Thalovant API access token.");
});
