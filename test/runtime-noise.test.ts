import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { noisePeer } from "./noise-peer.js";

const run = promisify(execFile);

it("serializes real HTTPS Noise runtime tools, preserves identity and releases failed calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-mcp-noise-"));
  const privateKey = join(directory, "tls.key");
  const certificate = join(directory, "tls.crt");
  let mcp: Client | undefined;
  let closeHub: (() => Promise<void>) | undefined;
  try {
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey,
      "-out", certificate, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"]);
    const hubKey = randomBytes(32);
    const password = randomBytes(32).toString("hex");
    let clientKey: Uint8Array | undefined;
    let active: ReturnType<typeof noisePeer> | undefined;
    let plain: string[] = [];
    let binary: string[] = [];
    const lifecycle: string[] = [];
    const patterns: string[] = [];
    const requests: string[] = [];
    const requestWaiters = new Map<string, () => void>();
    const observeRequest = (text: string) => new Promise<void>(resolve => requestWaiters.set(text, resolve));
    const errors: string[] = [];
    let overlap = false;
    const server = createServer({ key: await readFile(privateKey), cert: await readFile(certificate) }, (request, response) => {
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const reply = (body: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(body)); };
        try {
          if (!url.searchParams.get("authorization")) throw new Error("missing identity authorization");
          if (url.pathname !== "/connect" && request.headers.cookie !== "hivemind_http_replica=test-replica") {
            throw new Error("missing replica cookie");
          }
          switch (url.pathname) {
            case "/connect": {
              if (active) { overlap = true; reply({ status: "Connected" }); return; }
              lifecycle.push("connect"); plain = []; binary = [];
              active = noisePeer(password, (payload, encrypted) => {
                if (encrypted) binary.push(Buffer.from(payload).toString("base64"));
                else plain.push(String(payload));
              }, hubKey, clientKey);
              active.start();
              response.setHeader("Set-Cookie", "hivemind_http_replica=test-replica; Path=/; Secure");
              reply({ status: "Connected" }); return;
            }
            case "/get_messages": { const messages = plain; plain = []; reply({ messages }); return; }
            case "/get_binary_messages": { const messages = binary; binary = []; reply({ b64_messages: messages }); return; }
            case "/send_message": {
              if (!active) throw new Error("send outside admitted session");
              const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
              const raw = form.get("message") ?? "";
              const message = active.receive(form.get("binary") === "1" ? Buffer.from(raw, "base64") : raw);
              if (active.clientKey) clientKey = Buffer.from(active.clientKey, "hex");
              if (message?.msg_type === "hello") patterns.push(active.pattern!);
              if (message?.msg_type === "query") {
                expect(message.metadata.query_id).toBe("query-fixture");
                expect(message.payload.msg_type).toBe("bus");
                expect(message.payload.payload.type).toBe("recognizer_loop:utterance");
                const payload = message.payload.payload;
                expect(payload.context.request_id).toBe("request-fixture");
                expect(payload.context.session.session_id).toBe("session-fixture");
                expect(payload.data.lang).toBe("fr-fr");
                requests.push(payload.data.utterances[0]);
                active.replyQuery("foreign-query", { type: "speak", data: { utterance: "unrelated reply" }, context: payload.context });
                active.replyQuery("query-fixture", { type: "speak", data: { utterance: "routed reply" }, context: payload.context });
                active.replyQuery("query-fixture", { type: "hive.query.complete", data: {}, context: payload.context });
                reply({ status: "message sent" }); return;
              }
              if (message?.msg_type === "bus") {
                if (message.payload.type === "ovos.intent.list") {
                  active.reply({ type: "ovos.intent.list.response", data: { ok: true, intents: [{
                    skill_id: "test.weather", intent_name: "weather", lang: message.payload.data.lang,
                    method: "template", enabled: true, definition: { samples: ["[please] what is the weather"] },
                  }] }, context: message.payload.context });
                  reply({ status: "message sent" }); return;
                }
                if (message.payload.type === "ovos.skills.fallback.list") {
                  active.reply({ type: "ovos.skills.fallback.list.response", data: { fallbacks: [
                    { skill_id: "test.llm", priority: 100 },
                  ] }, context: message.payload.context });
                  reply({ status: "message sent" }); return;
                }
                expect(message.payload.type).toBe("recognizer_loop:utterance");
                const text = message.payload.data.utterances[0] as string;
                requests.push(text);
                expect(message.payload.context.stt_lang).toBe("fr-ca");
                expect(message.payload.context.session.pipeline).toEqual(["test-stage"]);
                expect(message.payload.context.location).toMatchObject({ city: "Montréal", country_code: "CA" });
                requestWaiters.get(text)?.();
                requestWaiters.delete(text);
                if (text === "fail") {
                  setTimeout(() => reply({ error: "synthetic send rejection" }), 100);
                  return;
                }
                const peer = active;
                setTimeout(() => {
                  if (active !== peer) { errors.push("session replaced before encrypted reply"); return; }
                  peer.reply({ type: "mycroft.audio.queue", data: { binary_data: Buffer.from("RIFF1234WAVEtest").toString("hex") }, context: message.payload.context });
                  peer.reply({ type: "speak", data: { utterance: `reply ${text}` }, context: message.payload.context });
                }, 100);
              }
              reply({ status: "message sent" }); return;
            }
            case "/disconnect": {
              if (active) lifecycle.push("disconnect");
              active = undefined; plain = []; binary = [];
              reply({ status: "Disconnected" }); return;
            }
            default: throw new Error("unexpected endpoint");
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "fixture failure");
          reply({ error: "invalid test request" });
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    closeHub = async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
    const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const identity = join(directory, "identity.json");
    await writeFile(identity, JSON.stringify({ key: "test-access", password, site_id: "test-site", default_master: endpoint, data_plane_endpoints: { https: endpoint }, protocols: { http: { enabled: true } } }), { mode: 0o600 });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith("THALOVANT_") || key.startsWith("MCP_") || ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS"].includes(key)) continue;
      env[key] = value;
    }
    env.NODE_EXTRA_CA_CERTS = certificate;
    env.XDG_CONFIG_HOME = join(directory, "config");
    const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env });
    mcp = new Client({ name: "noise-regression", version: "0.0.0" });
    await mcp.connect(transport);
    const ask = (text: string) => mcp!.callTool({ name: "thalovant_ask", arguments: { identityFile: identity, protocol: "https", text, timeoutMs: 5_000, replySettleMs: 0, sttLang: "fr-ca", pipeline: ["test-stage"], location: { city: " Montréal ", country: "ca" }, includeAudio: true } });
    const content = (result: Awaited<ReturnType<typeof ask>>) => JSON.parse((result.content as Array<{ type: string; text: string }>).find(item => item.type === "text")!.text);
    const status = await mcp.callTool({ name: "thalovant_identity_status", arguments: { identityFile: identity, protocol: "https" } });
    expect(status.isError).not.toBe(true);
    expect(lifecycle).toEqual([]);
    const oneObserved = observeRequest("one");
    const first = ask("one");
    await oneObserved;
    const [one, two] = await Promise.all([first, ask("two")]);
    expect(one.isError).not.toBe(true); expect(two.isError).not.toBe(true);
    expect(content(one).text).toBe("reply one");
    expect(content(one).hasAudio).toBe(true);
    expect(content(one).media).toMatchObject([{ eventIndex: 0, mimeType: "audio/wav" }]);
    expect(one.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "audio", mimeType: "audio/wav" })]));
    expect(JSON.stringify(content(one))).not.toContain("binary_data"); expect(content(two).text).toBe("reply two");
    const failureObserved = observeRequest("fail");
    const failing = ask("fail");
    await failureObserved;
    const [failed, recovered] = await Promise.all([failing, ask("recovered")]);
    expect(failed.isError).toBe(true); expect(recovered.isError).not.toBe(true);
    expect(content(recovered).text).toBe("reply recovered");
    const inventoryResult = await mcp.callTool({ name: "thalovant_intent_inventory", arguments: {
      identityFile: identity, protocol: "https", languages: ["en-us", "fr-fr"], timeoutMs: 5000, sentence: true,
    } });
    expect(inventoryResult.isError).not.toBe(true);
    const inventory = content(inventoryResult);
    expect(inventory.source).toBe("intent-manifest");
    expect(inventory.fallbacks_known).toBe(true);
    expect(inventory.fallbacks).toEqual([{ skill_id: "test.llm", priority: 100 }]);
    expect(inventory.may_answer).toEqual({ "en-us": true, "fr-fr": true });
    expect(inventory.skills[0].intents[0].phrases["en-us"]).toEqual(["[please] what is the weather"]);
    expect(inventory.examples[0].languages["en-us"]).toEqual(["What is the weather?"]);
    const queryResult = await mcp.callTool({ name: "thalovant_query", arguments: {
      identityFile: identity, protocol: "https", text: "routed query", lang: "fr-fr", timeoutMs: 5000,
      queryId: "query-fixture", requestId: "request-fixture", sessionId: "session-fixture", replySettleMs: 0,
    } });
    expect(queryResult.isError).not.toBe(true);
    expect(content(queryResult)).toMatchObject({ text: "routed reply", requestId: "request-fixture", sessionId: "session-fixture" });
    expect(requests).toEqual(["one", "two", "fail", "recovered", "routed query"]);
    expect(patterns).toEqual(["XXpsk2", "KKpsk0", "KKpsk0", "KKpsk0", "KKpsk0", "KKpsk0"]);
    expect(lifecycle).toEqual(Array.from({ length: 6 }, () => ["connect", "disconnect"]).flat());
    expect(overlap).toBe(false); expect(errors).toEqual([]);
    expect(clientKey).toBeDefined();
    const pins = JSON.parse(await readFile(join(directory, "config", "thalovant", "noise_pins.json"), "utf8"));
    expect(Object.keys(pins)).toEqual(["mcp-test-hub"]);
  } finally {
    await mcp?.close();
    await closeHub?.();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
