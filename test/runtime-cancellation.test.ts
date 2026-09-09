import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { noisePeer } from "./noise-peer.js";

const exec = promisify(execFile);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function watchdog<T>(work: Promise<T>, timeoutMs = 5000, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`test watchdog expired: ${label}`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

it.each(["stdio", "http"] as const)("propagates actual %s MCP cancellation without late execution or overlapping Noise identities", async mode => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-mcp-cancellation-"));
  let mcp: Client | undefined;
  let child: ChildProcess | undefined;
  let closeHub: (() => Promise<void>) | undefined;
  const releaseHeldResponses = new Set<() => void>();
  try {
    const keyFile = join(directory, "tls.key");
    const certFile = join(directory, "tls.crt");
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile,
      "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"]);
    const password = randomBytes(32).toString("hex");
    const hubKey = randomBytes(32);
    let clientKey: Uint8Array | undefined;
    let active: ReturnType<typeof noisePeer> | undefined;
    let plain: string[] = [];
    let binary: string[] = [];
    const requests: string[] = [];
    const lifecycle: string[] = [];
    const errors: string[] = [];
    const observers = new Map<string, ReturnType<typeof deferred>>();
    const observe = (name: string) => { const event = deferred(); observers.set(name, event); return event.promise; };
    const notify = (name: string) => { observers.get(name)?.resolve(); observers.delete(name); };
    let holdGreeting = false;
    let heldResponse: (() => void) | undefined;
    const server = createServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const reply = (body: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(body)); };
        try {
          const url = new URL(request.url ?? "/", "https://127.0.0.1");
          if (!url.searchParams.has("authorization")) throw new Error("missing authorization");
          if (url.pathname !== "/connect" && request.headers.cookie !== "hivemind_http_replica=test") throw new Error("missing replica affinity");
          switch (url.pathname) {
            case "/connect":
              if (active) throw new Error("overlapping runtime identities");
              lifecycle.push("connect"); plain = []; binary = [];
              active = noisePeer(password, (payload, encrypted) => {
                if (encrypted) binary.push(Buffer.from(payload).toString("base64"));
                else plain.push(String(payload));
              }, hubKey, clientKey);
              if (!holdGreeting) active.start();
              response.setHeader("Set-Cookie", "hivemind_http_replica=test; Path=/; Secure");
              reply({ status: "Connected" }); notify("connect"); return;
            case "/get_messages": { const messages = plain; plain = []; reply({ messages }); return; }
            case "/get_binary_messages": { const messages = binary; binary = []; reply({ b64_messages: messages }); return; }
            case "/send_message": {
              if (!active) throw new Error("send outside admitted identity");
              const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
              const raw = form.get("message") ?? "";
              const message = active.receive(form.get("binary") === "1" ? Buffer.from(raw, "base64") : raw);
              if (active.clientKey) clientKey = Buffer.from(active.clientKey, "hex");
              if (message?.msg_type === "hello") notify("ready");
              const payload = message?.msg_type === "query" ? message.payload.payload : message?.msg_type === "bus" ? message.payload : undefined;
              if (payload) {
                const text = payload.data.utterances?.[0] ?? payload.type;
                requests.push(text);
                if (text === "held.emit") {
                  heldResponse = () => { reply({ status: "message sent" }); releaseHeldResponses.delete(heldResponse!); };
                  releaseHeldResponses.add(heldResponse);
                  notify(text); return;
                }
                if (text === "owner" || text === "successor" || text === "cancelled-queued") {
                  active.reply({ type: "speak", data: { utterance: `reply ${text}` }, context: payload.context });
                }
                // Other application requests intentionally receive no reply.
                notify(text);
              }
              reply({ status: "message sent" }); return;
            }
            case "/disconnect":
              if (active) lifecycle.push("disconnect");
              active = undefined; plain = []; binary = [];
              reply({ status: "Disconnected" }); notify("disconnect"); return;
            default: throw new Error("unexpected runtime endpoint");
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "fixture failure");
          reply({ error: "invalid fixture request" });
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    closeHub = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
    const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const identityFile = join(directory, "identity.json");
    await writeFile(identityFile, JSON.stringify({ key: "synthetic-client", password, site_id: "test-site", default_master: endpoint,
      data_plane_endpoints: { https: endpoint }, protocols: { http: { enabled: true } } }), { mode: 0o600 });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith("THALOVANT_") || key.startsWith("MCP_") || ["ELECTRON_RUN_AS_NODE", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS"].includes(key)) continue;
      env[key] = value;
    }
    env.NODE_EXTRA_CA_CERTS = certFile;
    env.XDG_CONFIG_HOME = join(directory, "config");
    mcp = new Client({ name: "runtime-cancellation", version: "0.0.0" });
    if (mode === "stdio") {
      await mcp.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env }));
    } else {
      const listener = createNetServer();
      await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
      const port = (listener.address() as AddressInfo).port;
      await new Promise<void>(resolve => listener.close(() => resolve()));
      const credentialsFile = join(directory, "principals.json");
      const principalId = createHash("sha256").update("synthetic-mcp-token").digest("hex").slice(0, 32);
      await writeFile(credentialsFile, JSON.stringify({ principals: { [principalId]: { runtime: { identityFile } } } }), { mode: 0o600 });
      Object.assign(env, { MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: String(port), MCP_HTTP_AUTH_TOKEN: "synthetic-mcp-token",
        THALOVANT_PRINCIPAL_CREDENTIALS_FILE: credentialsFile });
      child = spawn(process.execPath, ["dist/index.js", "--http"], { env, stdio: "ignore" });
      const startupDeadline = performance.now() + 5000;
      let healthy = false;
      while (performance.now() < startupDeadline) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).ok) { healthy = true; break; }
        } catch { /* startup */ }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!healthy) throw new Error("MCP HTTP server did not become healthy");
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer synthetic-mcp-token" } },
      }));
    }
    const call = (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => mcp!.callTool({ name, arguments: {
      identityFile, protocol: "https", timeoutMs: 30000, ...args,
    } }, undefined, { signal, timeout: 40000 });
    // A protocol round trip ensures cancellation notifications have reached the
    // server before we release a held owner or assess successor execution.
    const barrier = () => mcp!.callTool({ name: "thalovant_config_status", arguments: {} });
    const cancel = async (controller: AbortController, pending: ReturnType<typeof call>) => {
      const rejection = expect(pending).rejects.toThrow();
      controller.abort();
      await rejection;
      await barrier();
    };
    const health = async () => {
      const result = await watchdog(call("thalovant_healthcheck", { timeoutMs: 30000 }), 5000, "healthy successor after cancellation");
      expect(result.isError).not.toBe(true);
    };

    // Cancellation during connect must reach the SDK, retire the handshake and
    // permit a successor well before the original 30-second operation budget.
    // Warm the real Noise key derivation outside the short successor watchdog.
    expect((await watchdog(call("thalovant_healthcheck"), 15000, "initial Noise readiness")).isError).not.toBe(true);
    for (const [name, args] of [
      ["thalovant_healthcheck", {}],
      ["thalovant_send_action", { payload: "never admitted action" }],
      ["thalovant_send_code", { value: "never admitted code" }],
      ["thalovant_emit_event", { eventType: "never.admitted" }],
      ["thalovant_intent_inventory", {}],
    ] as const) {
      holdGreeting = true;
      const connected = observe("connect");
      const connectingAbort = new AbortController();
      const connecting = call(name, args, connectingAbort.signal);
      await watchdog(connected, 5000, `${name} connect observed`);
      await cancel(connectingAbort, connecting);
      holdGreeting = false;
      await health();
    }

    // Each high-level waiting operation must forward the MCP request signal.
    for (const [name, args, observed] of [
      ["thalovant_ask", { text: "cancelled-ask" }, "cancelled-ask"],
      ["thalovant_query", { text: "cancelled-query", queryId: "cancel-query" }, "cancelled-query"],
      ["thalovant_wait_for_event", { eventName: "never.sent" }, "ready"],
    ] as const) {
      const admitted = observe(observed);
      const controller = new AbortController();
      const pending = call(name, args, controller.signal);
      await watchdog(admitted, 5000, `${name} admitted`);
      await cancel(controller, pending);
      await health();
    }

    // Emit has no SDK AbortSignal. It must finish its admitted physical write
    // before closing; cancellation must never replay it or admit another tool.
    const held = observe("held.emit");
    const emitAbort = new AbortController();
    const emit = call("thalovant_emit_event", { eventType: "held.emit" }, emitAbort.signal);
    await watchdog(held, 5000, "uncancellable emit admitted");
    const priorLifecycle = [...lifecycle];
    const queuedAbort = new AbortController();
    const queued = call("thalovant_ask", { text: "cancelled-queued", replySettleMs: 0 }, queuedAbort.signal);
    await barrier();
    await cancel(queuedAbort, queued);
    await cancel(emitAbort, emit);
    const successor = call("thalovant_ask", { text: "successor", replySettleMs: 0 });
    await barrier();
    expect(lifecycle).toEqual(priorLifecycle);
    expect(requests).not.toContain("cancelled-queued");
    expect(requests).not.toContain("successor");
    heldResponse!();
    expect((await watchdog(successor)).isError).not.toBe(true);
    expect(requests).toEqual(["cancelled-ask", "cancelled-query", "held.emit", "successor"]);
    expect(errors).toEqual([]);
    expect(lifecycle.filter(value => value === "connect")).toHaveLength(19);
    expect(lifecycle.filter(value => value === "disconnect")).toHaveLength(19);
    const pins = JSON.parse(await readFile(join(directory, "config", "thalovant", "noise_pins.json"), "utf8"));
    expect(Object.keys(pins)).toEqual(["mcp-test-hub"]);
  } finally {
    for (const release of releaseHeldResponses) release();
    await mcp?.close();
    if (child && child.exitCode === null) {
      const stopped = new Promise<void>(resolve => child!.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await watchdog(stopped).catch(() => child!.kill("SIGKILL"));
    }
    await closeHub?.();
    await rm(directory, { recursive: true, force: true });
  }
}, 45000);
