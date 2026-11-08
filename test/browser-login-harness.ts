/**
 * What the browser sign-in tests share: a loopback API that serves a case's
 * exchanges in order and checks every request, a raw TCP client that plays
 * the browser against the port a sign-in bound, stand-ins for the platform's
 * browser openers, and the built server over stdio with a chosen machine.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type Json = Record<string, unknown>;

export interface Exchange {
  request: { method: string; path: string; json?: unknown; authorization?: string };
  response: { status: number; content_type: string; body: string };
}

export interface BrowserRequest {
  method: string;
  target: string;
}

export interface SignInCase {
  name: string;
  call: { scopes?: string[] | null; device_name: string; timeout_ms?: number; then?: string; method?: string };
  exchanges: Exchange[];
  requests: BrowserRequest[];
  expect: Json;
  platform?: string;
  env?: Record<string, string>;
}

export interface BrowserVectors {
  state: { min_length: number; alphabet: string };
  verifier: { min_length: number; max_length: number; alphabet: string };
  pages: Record<string, string>;
  page_headers: Record<string, string>;
  prompt: { opening: string; not_opening: string };
  message_excludes: string[];
  pkce: Array<{ name: string; verifier: string; expect: Json }>;
  redirect_uris: Array<{ name: string; port: number; expect: Json }>;
  authorization_urls: Array<{
    name: string;
    input: {
      authorization_endpoint: string;
      client_id: string;
      port: number;
      code_challenge: string;
      state: string;
      scopes: string[] | null;
      device_name: string;
    };
    expect: Json;
  }>;
  config: Array<{ name: string; body: unknown; expect: Json }>;
  environment: Array<{ name: string; platform: string; env: Record<string, string>; expect: Json }>;
  callbacks: Array<{ name: string; request: BrowserRequest; expect: Json }>;
  sign_ins: SignInCase[];
  chooser: SignInCase[];
}

/** The reference's vectors, vendored byte for byte from the Python SDK's `contracts/conformance/`. */
export const BROWSER = JSON.parse(readFileSync(new URL("./browser-login-vectors.json", import.meta.url), "utf8")) as BrowserVectors;

const escapeClass = (alphabet: string): string => alphabet.replace(/[\\\]^-]/g, (char) => `\\${char}`);
export const STATE_RULE = new RegExp(`^[${escapeClass(BROWSER.state.alphabet)}]{${BROWSER.state.min_length},}$`);
export const VERIFIER_RULE = new RegExp(
  `^[${escapeClass(BROWSER.verifier.alphabet)}]{${BROWSER.verifier.min_length},${BROWSER.verifier.max_length}}$`,
);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// -- the browser --------------------------------------------------------------------

export interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
  page: string | null;
}

/** One request on its own connection, as a browser tab sends it; the whole answer, read to its end. */
export async function http(port: number, method: string, target: string): Promise<Answer> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks)));
    socket.once("connect", () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`, "utf8");
    });
  });
  const split = raw.indexOf("\r\n\r\n");
  assert.ok(split > 0, `no answer: ${JSON.stringify(raw.toString("latin1"))}`);
  const lines = raw.subarray(0, split).toString("latin1").split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const body = raw.subarray(split + 4).toString("utf8");
  const page = Object.entries(BROWSER.pages).find(([, text]) => body.includes(text))?.[0] ?? null;
  return { status: Number(lines[0]!.split(" ")[1]), headers, body, page };
}

/** Every listener answer carries the contract's headers and loads nothing. */
export function checkPageHeaders(answer: Answer): void {
  for (const [name, value] of Object.entries(BROWSER.page_headers)) {
    assert.equal(answer.headers[name], value, `${name} in ${JSON.stringify(answer.headers)}`);
  }
  for (const loads of ["src=", "href=", "http"]) assert.ok(!answer.body.includes(loads), answer.body);
}

/** Whether a new connection to the port is refused. */
export function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

function base64UrlSha256(text: string): string {
  return createHash("sha256").update(text, "ascii").digest("base64url");
}

/** What a test learnt from the authorization URL a sign-in built. */
export class Signing {
  readonly endpoint: string;
  readonly pairs: Array<[string, string]>;
  readonly port: number;
  readonly state: string;
  readonly challenge: string;

  constructor(readonly url: string) {
    const mark = url.indexOf("?");
    assert.ok(mark > 0, url);
    this.endpoint = url.slice(0, mark);
    this.pairs = [...new URLSearchParams(url.slice(mark + 1))];
    const values = Object.fromEntries(this.pairs);
    const redirect = new URL(values.redirect_uri!);
    this.port = Number(redirect.port);
    this.state = values.state!;
    this.challenge = values.code_challenge!;
    assert.match(this.state, STATE_RULE, "state must be at least 128 bits of base64url");
    assert.match(this.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(values.redirect_uri, `http://127.0.0.1:${this.port}/callback`);
    assert.ok(this.port >= 1024 && this.port <= 65535, String(this.port));
  }

  normalized(text: string): string {
    return text
      .replaceAll(`http://127.0.0.1:${this.port}/callback`, "http://127.0.0.1:{port}/callback")
      .replaceAll(this.state, "{state}")
      .replaceAll(this.challenge, "{challenge}");
  }

  urlRecord(): Json {
    return { endpoint: this.endpoint, query: this.pairs.map(([key, value]) => [key, this.normalized(value)]) };
  }
}

// -- the API ------------------------------------------------------------------------

/** Serves a case's exchanges in order and checks each request against its own. */
export class ScriptedApi {
  sent: string[] = [];
  mismatches: string[] = [];
  index = 0;
  url = "";
  signing?: Signing;
  exchange?: Json;
  verifier?: string;
  private exchanges: Exchange[] = [];
  private server?: Server;

  constructor(exchanges: Exchange[] = []) {
    this.exchanges = exchanges;
  }

  /** A new case's exchanges, and nothing remembered from the last one. */
  use(exchanges: Exchange[]): void {
    this.exchanges = exchanges;
    this.sent = [];
    this.mismatches = [];
    this.index = 0;
    this.signing = undefined;
    this.exchange = undefined;
    this.verifier = undefined;
  }

  get allUsed(): boolean {
    return this.index === this.exchanges.length;
  }

  async start(): Promise<this> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** The exchange body with the generated values put back as placeholders, once proven. */
  private tokenBody(body: unknown): unknown {
    if (!body || typeof body !== "object" || Array.isArray(body) || !this.signing) return body;
    const fields = body as Json;
    const keys = Object.keys(fields).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["client_id", "code", "code_verifier", "redirect_uri"])) {
      this.mismatches.push(`the exchange must carry exactly four fields, not ${JSON.stringify(keys)}`);
    }
    const clean: Json = {};
    for (const [key, value] of Object.entries(fields)) {
      clean[key] = typeof value === "string" ? this.signing.normalized(value) : value;
    }
    const verifier = fields.code_verifier;
    if (typeof verifier === "string" && VERIFIER_RULE.test(verifier) && base64UrlSha256(verifier) === this.signing.challenge) {
      clean.code_verifier = "{verifier}";
      this.verifier = verifier;
    } else {
      this.mismatches.push("the code_verifier is not the one the challenge was made from");
    }
    this.exchange = clean;
    return clean;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    this.sent.push(`${request.method} ${path}`);
    const exchange = this.exchanges[this.index];
    if (!exchange) {
      this.mismatches.push(`unexpected ${request.method} ${path}`);
      response.writeHead(599).end("{}");
      return;
    }
    this.index += 1;
    const expected = exchange.request;
    if (request.method !== expected.method || path !== expected.path) {
      this.mismatches.push(`${request.method} ${path} != ${expected.method} ${expected.path}`);
    }
    let body: unknown = raw ? JSON.parse(raw) : null;
    const carriesVerifier = !!body && typeof body === "object" && !Array.isArray(body) && "code_verifier" in body;
    if ((path === expected.path && path === "/v1/auth/native/token") || carriesVerifier) body = this.tokenBody(body);
    if ("json" in expected) {
      try {
        assert.deepStrictEqual(body, expected.json);
      } catch {
        this.mismatches.push(`body ${JSON.stringify(body)} != ${JSON.stringify(expected.json)}`);
      }
    }
    if ("authorization" in expected && request.headers.authorization !== expected.authorization) {
      this.mismatches.push("wrong Authorization header");
    }
    const answer = Buffer.from(exchange.response.body, "utf8");
    response.writeHead(
      exchange.response.status,
      answer.length ? { "content-type": exchange.response.content_type, "content-length": String(answer.length) } : {},
    );
    response.end(answer);
  }
}

// -- the machine the server runs on ---------------------------------------------------

/** The variables the browser rule reads; a server is started with exactly a case's. */
export const BROWSER_VARIABLES = ["CI", "SSH_CONNECTION", "SSH_TTY", "DISPLAY", "WAYLAND_DISPLAY"];
/** The vectors' platform names, as Node spells them. */
export const NODE_PLATFORMS: Record<string, string> = { macos: "darwin", windows: "win32" };

/**
 * Stand-ins for `xdg-open`, `open` and `rundll32.exe`, first on the PATH a
 * server is started with: each writes the URL it was asked to open to a file,
 * so a test sees what the server opened and no real browser starts.
 */
export class BrowserShims {
  readonly dir = mkdtempSync(join(tmpdir(), "thalovant-mcp-browser-"));
  readonly log = join(this.dir, "opened.log");

  constructor() {
    writeFileSync(this.log, "");
    for (const name of ["xdg-open", "open", "rundll32.exe"]) {
      const path = join(this.dir, name);
      // The URL is the last argument (`open -- <url>`, `rundll32 url.dll,FileProtocolHandler <url>`).
      writeFileSync(path, '#!/bin/sh\nfor last; do :; done\nprintf \'%s\\n\' "$last" >> "$(dirname "$0")/opened.log"\n');
      chmodSync(path, 0o755);
    }
  }

  /** The URLs opened so far, in order. */
  opened(): string[] {
    return readFileSync(this.log, "utf8").split("\n").filter(Boolean);
  }

  /** Wait until `url` was opened (the opener is not waited for), or give up after a while. */
  async openedWithin(url: string, ms = 5_000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (this.opened().includes(url)) return true;
      await sleep(25);
    }
    return this.opened().includes(url);
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** This process's environment without Thalovant, MCP or browser-rule variables, plus `env`, with the shims first on PATH. */
export function machineEnv(env: Record<string, string>, shims?: BrowserShims): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("THALOVANT_") || key.startsWith("MCP_") || BROWSER_VARIABLES.includes(key)) continue;
    out[key] = value;
  }
  if (shims) out.PATH = `${shims.dir}${delimiter}${out.PATH ?? ""}`;
  return { ...out, ...env };
}

/** The built server over stdio, on a machine with `env` and, when given, the vectors' `platform`. */
export async function stdioServer(options: {
  env: Record<string, string>;
  shims?: BrowserShims;
  platform?: string;
}): Promise<{ client: Client; stderr: () => string }> {
  const env = machineEnv(options.env, options.shims);
  const args = ["dist/index.js"];
  if (options.platform) {
    env.THALOVANT_TEST_PLATFORM = NODE_PLATFORMS[options.platform] ?? options.platform;
    args.unshift("--import", new URL("./platform-preload.mjs", import.meta.url).href);
  }
  const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "thalovant-mcp-browser-login", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

export async function tool(client: Client, name: string, args: Json): Promise<{ error: boolean; text: string; json?: Json }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).map((item) => item.text ?? "").join("\n");
  if (result.isError) return { error: true, text };
  return { error: false, text, json: JSON.parse(text) as Json };
}

/** Poll a sign-in until it is no longer pending. */
export async function pollUntilEnded(client: Client, loginId: string, ms = 15_000): Promise<{ error: boolean; text: string; json?: Json }> {
  const until = Date.now() + ms;
  for (;;) {
    const answer = await tool(client, "thalovant_poll_browser_login", { loginId });
    if (answer.error || answer.json!.outcome !== "pending") return answer;
    if (Date.now() > until) throw new Error(`sign-in ${loginId} still pending after ${ms} ms`);
    await sleep(25);
  }
}

/** A tool error's status, code and detail, read from its text the way a model reads it. */
export function errorFields(text: string): { status: number | null; code: string | null; detail: string | null } {
  const status = /HTTP (\d{3})\b/.exec(text);
  const code = /^code: (.+)$/m.exec(text);
  const detail = /^detail: (.+)$/m.exec(text);
  return { status: status ? Number(status[1]) : null, code: code ? code[1]! : null, detail: detail ? detail[1]! : null };
}

/** The vectors' result shape, from what thalovant_poll_browser_login answered. */
export function polledResult(out: Json): Json {
  if (out.outcome === "approved") {
    return { outcome: "approved", token_type: out.tokenType, scopes: out.scopes, expires_at: out.expiresAt, token_id: out.tokenId };
  }
  if (out.outcome === "denied" || out.outcome === "expired") return { outcome: out.outcome, status: out.status };
  const produced: Json = { outcome: "error", status: out.status, code: out.code };
  if (out.status !== null) produced.detail = out.detail;
  return produced;
}

/** The vectors' result shape, from a begin that failed before anything was shown. */
export function failedResult(text: string): Json {
  const fields = errorFields(text);
  const produced: Json = { outcome: "error", status: fields.status, code: fields.code };
  if (fields.status !== null) produced.detail = fields.detail;
  return produced;
}

/**
 * No synthetic secret (the code, the tokens), nor this sign-in's verifier, in
 * `text`, nor its state unless `withState` (the consent URL a begin answers
 * with carries the state by design: it is what the person opens).
 */
export function noSecretsIn(text: string, api: ScriptedApi, withState = false): void {
  const hidden = [...BROWSER.message_excludes];
  if (api.verifier) hidden.push(api.verifier);
  if (api.signing && !withState) hidden.push(api.signing.state);
  for (const value of hidden) assert.ok(!text.includes(value), "a secret reached the tool's answer");
}
