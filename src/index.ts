#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { EventId, EventStore, StreamId } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_CONTROL_API_URL,
  ThalovantClient,
  ThalovantControlPlane,
  ThalovantIdentity,
  buildClientContext,
} from "@thalovant/sdk";
import type {
  AnalyticsOverviewOptions,
  HubProtocol,
  IdentityInput,
  MemoryCreatePayload,
  MemoryListOptions,
  MemoryUpdatePayload,
  ThalovantDisplayItem,
  ThalovantReply,
} from "@thalovant/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { z } from "zod";

const VERSION = "0.1.6";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_LIMIT = 100;
const DEFAULT_HTTP_BODY_LIMIT_BYTES = 1_048_576;
const DEFAULT_HTTP_RATE_LIMIT_MAX = 120;
const DEFAULT_HTTP_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_HTTP_SESSION_TTL_MS = 3_600_000;
const DEFAULT_OAUTH_SCOPE = "mcp:thalovant";
const SECRET_KEYS = [
  "access_token",
  "accessToken",
  "access_key",
  "accessKey",
  "api_key",
  "apiKey",
  "password",
  "broker_password",
  "brokerPassword",
  "client_secret",
  "clientSecret",
  "crypto_key",
  "cryptoKey",
  "private_key",
  "privateKey",
  "refresh_token",
  "refreshToken",
  "authToken",
  "authorization",
  "bearer",
  "token",
  "secret",
];

const protocolSchema = z.enum(["wss", "https", "mqtt"]);
const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(25);
const optionalCursorSchema = z.string().min(1).optional();
const jsonRecordSchema = z.record(z.unknown());

const controlPlaneSchema = {
  loginScope: z
    .string()
    .min(1)
    .optional()
    .describe("Optional login scope used with THALOVANT_EMAIL and THALOVANT_PASSWORD."),
  apiUrl: z
    .string()
    .url()
    .optional()
    .describe("Control-plane base URL. Defaults to https://api.thalovant.com."),
};

const contextSchema = z
  .object({
    userId: z.string().min(1).optional(),
    userName: z.string().min(1).optional(),
    authProvider: z.string().min(1).optional(),
    authClaims: jsonRecordSchema.optional(),
    roles: z.array(z.string().min(1)).optional(),
    platform: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    destination: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    deviceId: z.string().min(1).optional(),
    locale: z.string().min(1).optional(),
    metadata: jsonRecordSchema.optional(),
    sessionId: z.string().min(1).optional(),
  })
  .optional();

const runtimeAuthSchema = {
  identityFile: z
    .string()
    .min(1)
    .optional()
    .describe("Path to a Thalovant identity JSON file."),
  configPath: z
    .string()
    .min(1)
    .optional()
    .describe("Path to a Thalovant SDK config file."),
  profile: z.string().min(1).optional().describe("SDK config profile name."),
  fromEnv: z
    .boolean()
    .default(false)
    .describe("Load the identity from Thalovant SDK environment variables."),
  protocol: protocolSchema.default("wss").describe("Runtime transport protocol."),
};

interface HttpConfig {
  host: string;
  port: number;
  path: string;
  publicUrl: URL;
  resourceUrl: URL;
  resourceMetadataUrl: URL;
  authTokens: string[];
  allowUnauthenticated: boolean;
  authMode: "static" | "jwt" | "introspection";
  oauthIssuer?: string;
  oauthJwksUrl?: string;
  oauthAudience?: string;
  oauthAuthorizationServers: string[];
  oauthRequiredScopes: string[];
  oauthScopesSupported: string[];
  oauthIntrospectionUrl?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxBodyBytes: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  sessionTtlMs: number;
  eventStoreFile?: string;
  enableJsonResponse: boolean;
  trustProxy: boolean;
}

interface AuthResult {
  userId: string;
  clientId: string;
  scopes: string[];
  token?: string;
  expiresAt?: number;
  claims?: Record<string, unknown>;
}

interface Principal {
  id: string;
  clientId?: string;
  subject?: string;
  scopes: string[];
  claims?: Record<string, unknown>;
}

interface PrincipalCredentialConfig {
  control?: {
    apiUrl?: string;
    accessToken?: string;
  };
  runtime?: {
    identity?: IdentityInput;
    identityFile?: string;
    configPath?: string;
    profile?: string;
    fromEnv?: boolean;
  };
  allowedTools?: string[];
  deniedTools?: string[];
}

interface PrincipalCredentialFile {
  default?: PrincipalCredentialConfig;
  principals?: Record<string, PrincipalCredentialConfig>;
}

interface RequestContext {
  toolName: string;
  principal: Principal;
}

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
  createdAt: number;
  lastSeen: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class InMemoryEventStore implements EventStore {
  protected readonly eventIdToStreamId = new Map<EventId, StreamId>();
  protected readonly streamEvents = new Map<StreamId, Array<{ eventId: EventId; message: JSONRPCMessage }>>();
  private counter = 0;

  constructor(private readonly maxEventsPerStream = 200) {}

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = `${Date.now()}-${++this.counter}`;
    this.addEvent(streamId, eventId, message);
    return eventId;
  }

  protected addEvent(streamId: StreamId, eventId: EventId, message: JSONRPCMessage): void {
    this.eventIdToStreamId.set(eventId, streamId);
    const events = this.streamEvents.get(streamId) ?? [];
    events.push({ eventId, message });
    while (events.length > this.maxEventsPerStream) {
      const removed = events.shift();
      if (removed) this.eventIdToStreamId.delete(removed.eventId);
    }
    this.streamEvents.set(streamId, events);
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.eventIdToStreamId.get(eventId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const streamId = this.eventIdToStreamId.get(lastEventId);
    if (!streamId) {
      throw new Error(`Unknown event id: ${lastEventId}`);
    }
    const events = this.streamEvents.get(streamId) ?? [];
    const lastIndex = events.findIndex((event) => event.eventId === lastEventId);
    for (const event of events.slice(lastIndex + 1)) {
      await send(event.eventId, event.message);
    }
    return streamId;
  }
}

class FileEventStore extends InMemoryEventStore {
  private constructor(private readonly filePath: string) {
    super();
  }

  static async create(filePath: string): Promise<FileEventStore> {
    const store = new FileEventStore(resolve(filePath));
    try {
      const data = await readFile(store.filePath, "utf8");
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { streamId: StreamId; eventId: EventId; message: JSONRPCMessage };
        store.addEvent(event.streamId, event.eventId, event.message);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    return store;
  }

  override async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = await super.storeEvent(streamId, message);
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await appendFile(this.filePath, `${stableStringify({ streamId, eventId, message })}\n`, { mode: 0o600 });
    return eventId;
  }
}

class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      const resetAt = now + this.windowMs;
      this.entries.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: Math.max(this.maxRequests - 1, 0), resetAt };
    }

    entry.count += 1;
    const allowed = entry.count <= this.maxRequests;
    return {
      allowed,
      remaining: Math.max(this.maxRequests - entry.count, 0),
      resetAt: entry.resetAt,
    };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}

const requestContext = new AsyncLocalStorage<RequestContext>();
let credentialsFileCache: Promise<PrincipalCredentialFile | undefined> | undefined;

function textContent(text: string, data?: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: data === undefined ? text : `${text}\n\n${stableStringify(data)}`,
      },
    ],
  };
}

function jsonContent(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: stableStringify(data),
      },
    ],
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function currentPrincipal(): Principal {
  return requestContext.getStore()?.principal ?? {
    id: "local",
    clientId: "local",
    scopes: ["local"],
  };
}

function isRemotePrincipal(principal = currentPrincipal()): boolean {
  return principal.id !== "local";
}

function principalFromExtra(extra: { authInfo?: AuthInfo } | undefined): Principal {
  const authInfo = extra?.authInfo;
  if (!authInfo) {
    return { id: "local", clientId: "local", scopes: ["local"] };
  }
  const claims = authInfo.extra?.claims && typeof authInfo.extra.claims === "object" ? (authInfo.extra.claims as Record<string, unknown>) : undefined;
  const principalId =
    (typeof authInfo.extra?.principalId === "string" && authInfo.extra.principalId) ||
    (typeof claims?.sub === "string" && claims.sub) ||
    authInfo.clientId;
  return {
    id: principalId,
    clientId: authInfo.clientId,
    subject: typeof claims?.sub === "string" ? claims.sub : undefined,
    scopes: authInfo.scopes,
    claims,
  };
}

function principalCredentialKeys(principal: Principal): string[] {
  return Array.from(new Set([principal.id, principal.subject, principal.clientId].filter((value): value is string => Boolean(value))));
}

function hashedPrincipalFileName(principalId: string): string {
  return `${createHash("sha256").update(principalId).digest("hex")}.json`;
}

async function loadCredentialFile(): Promise<PrincipalCredentialFile | undefined> {
  const path = process.env.THALOVANT_PRINCIPAL_CREDENTIALS_FILE;
  if (!path) return undefined;
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as PrincipalCredentialFile;
    return data;
  } catch (error) {
    throw new Error(`Unable to read THALOVANT_PRINCIPAL_CREDENTIALS_FILE: ${path}: ${String(error)}`);
  }
}

async function loadCredentialFromDir(principal: Principal): Promise<PrincipalCredentialConfig | undefined> {
  const dir = process.env.THALOVANT_PRINCIPAL_CREDENTIALS_DIR;
  if (!dir) return undefined;
  for (const key of principalCredentialKeys(principal)) {
    const filePath = resolve(dir, hashedPrincipalFileName(key));
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as PrincipalCredentialConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to read principal credential file: ${filePath}: ${String(error)}`);
      }
    }
  }
  return undefined;
}

async function credentialForPrincipal(principal = currentPrincipal()): Promise<PrincipalCredentialConfig | undefined> {
  const fromDir = await loadCredentialFromDir(principal);
  if (fromDir) return fromDir;
  credentialsFileCache ??= loadCredentialFile();
  const file = await credentialsFileCache;
  if (!file) return undefined;
  for (const key of principalCredentialKeys(principal)) {
    const credential = file.principals?.[key];
    if (credential) return credential;
  }
  return parseBool(process.env.THALOVANT_ALLOW_DEFAULT_PRINCIPAL_CREDENTIALS, false) ? file.default : undefined;
}

function allowSharedThalovantCredentials(principal = currentPrincipal()): boolean {
  return !isRemotePrincipal(principal) || parseBool(process.env.THALOVANT_ALLOW_SHARED_CREDENTIALS, false);
}

function toolListFromEnv(...names: string[]): string[] {
  return names.flatMap((name) => parseCsv(process.env[name]));
}

function toolPatternMatches(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

function listAllowsTool(patterns: string[] | undefined, toolName: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => toolPatternMatches(pattern, toolName));
}

function listDeniesTool(patterns: string[] | undefined, toolName: string): boolean {
  return Boolean(patterns?.some((pattern) => toolPatternMatches(pattern, toolName)));
}

async function authorizeTool(toolName: string, principal: Principal): Promise<void> {
  const globalAllow = toolListFromEnv("MCP_TOOL_ALLOWLIST", "THALOVANT_MCP_TOOL_ALLOWLIST");
  const globalDeny = toolListFromEnv("MCP_TOOL_DENYLIST", "THALOVANT_MCP_TOOL_DENYLIST");
  if (!listAllowsTool(globalAllow, toolName) || listDeniesTool(globalDeny, toolName)) {
    throw new Error(`Tool ${toolName} is disabled by server policy.`);
  }
  const credential = await credentialForPrincipal(principal);
  if (!listAllowsTool(credential?.allowedTools, toolName) || listDeniesTool(credential?.deniedTools, toolName)) {
    throw new Error(`Tool ${toolName} is disabled for this principal.`);
  }
}

async function auditLog(event: Record<string, unknown>): Promise<void> {
  const mode = process.env.MCP_AUDIT_LOG ?? "off";
  if (mode === "off") return;
  const payload = `${JSON.stringify(redactSecrets(event))}\n`;
  if (mode === "stderr" || mode === "both") {
    console.error(payload.trimEnd());
  }
  const file = process.env.MCP_AUDIT_LOG_FILE;
  if ((mode === "file" || mode === "both" || file) && file) {
    await mkdir(dirname(resolve(file)), { recursive: true, mode: 0o700 });
    await appendFile(file, payload, { mode: 0o600 });
  }
}

function registerThalovantTool(
  server: McpServer,
  name: string,
  config: Record<string, unknown>,
  handler: (args: any, extra: any) => unknown | Promise<unknown>,
): void {
  (server.registerTool as any)(name, config, async (args: any, extra: any) => {
    const principal = principalFromExtra(extra);
    const start = Date.now();
    try {
      await authorizeTool(name, principal);
      const result = await requestContext.run({ toolName: name, principal }, () => handler(args, extra));
      await auditLog({
        ts: new Date().toISOString(),
        event: "mcp.tool",
        tool: name,
        principalId: principal.id,
        clientId: principal.clientId,
        status: "ok",
        durationMs: Date.now() - start,
        args: parseBool(process.env.MCP_AUDIT_INCLUDE_ARGS, false) ? args : undefined,
      });
      return result as any;
    } catch (error) {
      await auditLog({
        ts: new Date().toISOString(),
        event: "mcp.tool",
        tool: name,
        principalId: principal.id,
        clientId: principal.clientId,
        status: "error",
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS);
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    const isSecret = SECRET_KEYS.some((secretKey) => normalized.includes(secretKey.toLowerCase()));
    output[key] = isSecret ? "[redacted]" : redactSecrets(nestedValue);
  }
  return output;
}

async function createControlPlane(options: {
  apiUrl?: string;
  loginScope?: string;
}): Promise<ThalovantControlPlane> {
  const principal = currentPrincipal();
  const credential = await credentialForPrincipal(principal);
  const canUseShared = allowSharedThalovantCredentials(principal);
  const apiUrl = options.apiUrl ?? credential?.control?.apiUrl ?? (canUseShared ? process.env.THALOVANT_API_URL : undefined) ?? DEFAULT_CONTROL_API_URL;
  const accessToken = credential?.control?.accessToken ?? (canUseShared ? process.env.THALOVANT_ACCESS_TOKEN : undefined);
  const api = new ThalovantControlPlane(apiUrl, {
    accessToken,
    userAgent: `thalovant-mcp/${VERSION}`,
  });

  if (!accessToken && canUseShared) {
    const email = process.env.THALOVANT_EMAIL;
    const password = process.env.THALOVANT_PASSWORD;
    if (email && password) {
      await api.login(email, password, { scope: options.loginScope ?? process.env.THALOVANT_SCOPE });
    }
  }

  return api;
}

function ensureAuthenticated(api: ThalovantControlPlane) {
  if (!api.accessToken) {
    throw new Error(
      "This tool requires Thalovant API auth. Configure THALOVANT_ACCESS_TOKEN, THALOVANT_EMAIL/THALOVANT_PASSWORD, or per-principal Thalovant credentials for this MCP principal.",
    );
  }
}

async function createRuntimeClient(options: {
  identityFile?: string;
  configPath?: string;
  profile?: string;
  fromEnv?: boolean;
  protocol?: HubProtocol;
}): Promise<ThalovantClient> {
  const protocol = options.protocol ?? "wss";
  const principal = currentPrincipal();
  const credential = await credentialForPrincipal(principal);
  const runtimeCredential = credential?.runtime;
  const canUseShared = allowSharedThalovantCredentials(principal);
  const canUseToolPaths = canUseShared || parseBool(process.env.MCP_HTTP_ALLOW_CLIENT_CREDENTIAL_PATHS, false);

  if (runtimeCredential?.identity) {
    return new ThalovantClient(new ThalovantIdentity(runtimeCredential.identity), { protocol });
  }
  if (runtimeCredential?.identityFile) {
    return ThalovantClient.fromIdentityFile(runtimeCredential.identityFile, { protocol });
  }
  if (runtimeCredential?.configPath || runtimeCredential?.profile) {
    return ThalovantClient.fromConfig({
      path: runtimeCredential.configPath,
      profile: runtimeCredential.profile,
      protocol,
    });
  }
  if (runtimeCredential?.fromEnv && canUseShared) {
    return ThalovantClient.fromEnv({ protocol });
  }

  if (isRemotePrincipal(principal) && !canUseShared && !canUseToolPaths) {
    throw new Error("No per-principal Thalovant runtime identity is configured for this authenticated MCP principal.");
  }

  if (!canUseToolPaths && (options.identityFile || options.configPath || options.profile || options.fromEnv)) {
    throw new Error("Runtime identity path/config arguments are disabled for remote MCP principals.");
  }

  if (options.identityFile) {
    return ThalovantClient.fromIdentityFile(options.identityFile, { protocol });
  }
  if (options.configPath || options.profile) {
    return ThalovantClient.fromConfig({
      path: options.configPath,
      profile: options.profile ?? process.env.THALOVANT_PROFILE,
      protocol,
    });
  }
  if (!canUseShared) {
    throw new Error("No per-principal Thalovant runtime identity is configured for this authenticated MCP principal.");
  }
  if (options.fromEnv || process.env.THALOVANT_ACCESS_KEY) {
    return ThalovantClient.fromEnv({ protocol });
  }
  return ThalovantClient.fromConfig({
    profile: process.env.THALOVANT_PROFILE,
    protocol,
  });
}

function summarizeReply(reply: ThalovantReply) {
  const displayItems = reply.displayItems({ maxTextChars: 1_000 }) as ThalovantDisplayItem[];
  return {
    text: reply.text,
    displayText: reply.displayText,
    utterances: reply.utterances,
    handled: reply.handled,
    ok: reply.ok,
    sessionId: reply.sessionId,
    requestId: reply.requestId,
    displayItems,
    events: reply.events.map((event) => redactSecrets(event.asObject())),
    failureEvent: reply.failureEvent ? redactSecrets(reply.failureEvent.asObject()) : undefined,
  };
}

async function saveIdentity(path: string, identity: ThalovantIdentity): Promise<string> {
  const resolvedPath = resolve(path);
  await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  await writeFile(resolvedPath, `${stableStringify(identity.asObject(true))}\n`, { mode: 0o600 });
  return resolvedPath;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseInteger(value: string | undefined, defaultValue: number, options?: { min?: number; max?: number }): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  const min = options?.min ?? Number.MIN_SAFE_INTEGER;
  const max = options?.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeHttpPath(path: string | undefined): string {
  const raw = path?.trim() || "/mcp";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function originForHost(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  const bracketedHost = displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
  return `http://${bracketedHost}:${port}`;
}

function isLoopbackBindHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
}

function defaultAllowedHosts(host: string, port: number): string[] {
  if (isLoopbackBindHost(host)) {
    return Array.from(
      new Set([
        `${host}:${port}`,
        host,
        `127.0.0.1:${port}`,
        "127.0.0.1",
        `localhost:${port}`,
        "localhost",
        `[::1]:${port}`,
        "[::1]",
      ]),
    );
  }
  return [];
}

function getHttpConfig(): HttpConfig {
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = parseInteger(process.env.MCP_HTTP_PORT, 3000, { min: 1, max: 65_535 });
  const path = normalizeHttpPath(process.env.MCP_HTTP_PATH);
  const publicUrl = new URL(process.env.MCP_PUBLIC_URL ?? process.env.MCP_HTTP_PUBLIC_URL ?? originForHost(host, port));
  const resourceUrl = new URL(process.env.MCP_RESOURCE_URL ?? path, publicUrl);
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource", publicUrl);
  const allowedHosts =
    parseCsv(process.env.MCP_HTTP_ALLOWED_HOSTS ?? process.env.MCP_ALLOWED_HOSTS).length > 0
      ? parseCsv(process.env.MCP_HTTP_ALLOWED_HOSTS ?? process.env.MCP_ALLOWED_HOSTS)
      : defaultAllowedHosts(host, port);
  const authTokens = parseCsv(process.env.MCP_HTTP_AUTH_TOKENS ?? process.env.MCP_HTTP_AUTH_TOKEN ?? process.env.MCP_AUTH_TOKEN);
  const allowUnauthenticated = parseBool(process.env.MCP_HTTP_ALLOW_UNAUTHENTICATED, false);
  const oauthJwksUrl = process.env.MCP_OAUTH_JWKS_URL;
  const oauthIntrospectionUrl = process.env.MCP_OAUTH_INTROSPECTION_URL;
  const authMode =
    process.env.MCP_HTTP_AUTH_MODE === "jwt" || oauthJwksUrl
      ? "jwt"
      : process.env.MCP_HTTP_AUTH_MODE === "introspection" || oauthIntrospectionUrl
        ? "introspection"
        : "static";

  if (!allowUnauthenticated && authMode === "static" && authTokens.length === 0) {
    throw new Error("HTTP mode requires MCP_HTTP_AUTH_TOKEN or MCP_HTTP_AUTH_TOKENS. Set MCP_HTTP_ALLOW_UNAUTHENTICATED=true only for local development.");
  }
  if (authMode === "jwt" && !oauthJwksUrl) {
    throw new Error("JWT auth mode requires MCP_OAUTH_JWKS_URL.");
  }
  if (authMode === "introspection" && !oauthIntrospectionUrl) {
    throw new Error("Introspection auth mode requires MCP_OAUTH_INTROSPECTION_URL.");
  }
  if (allowedHosts.length === 0) {
    throw new Error("HTTP mode requires MCP_HTTP_ALLOWED_HOSTS when binding to a non-loopback host.");
  }

  return {
    host,
    port,
    path,
    publicUrl,
    resourceUrl,
    resourceMetadataUrl,
    authTokens,
    allowUnauthenticated,
    authMode,
    oauthIssuer: process.env.MCP_OAUTH_ISSUER,
    oauthJwksUrl,
    oauthAudience: process.env.MCP_OAUTH_AUDIENCE ?? resourceUrl.toString(),
    oauthAuthorizationServers: parseCsv(process.env.MCP_OAUTH_AUTHORIZATION_SERVERS ?? process.env.MCP_OAUTH_ISSUER),
    oauthRequiredScopes: parseCsv(process.env.MCP_OAUTH_REQUIRED_SCOPES ?? DEFAULT_OAUTH_SCOPE),
    oauthScopesSupported: parseCsv(process.env.MCP_OAUTH_SCOPES_SUPPORTED ?? DEFAULT_OAUTH_SCOPE),
    oauthIntrospectionUrl,
    oauthClientId: process.env.MCP_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
    allowedHosts,
    allowedOrigins: parseCsv(process.env.MCP_HTTP_ALLOWED_ORIGINS ?? process.env.MCP_ALLOWED_ORIGINS),
    maxBodyBytes: parseInteger(process.env.MCP_HTTP_MAX_BODY_BYTES, DEFAULT_HTTP_BODY_LIMIT_BYTES, {
      min: 1_024,
      max: 20 * 1_048_576,
    }),
    rateLimitMax: parseInteger(process.env.MCP_HTTP_RATE_LIMIT_MAX, DEFAULT_HTTP_RATE_LIMIT_MAX, { min: 1 }),
    rateLimitWindowMs: parseInteger(process.env.MCP_HTTP_RATE_LIMIT_WINDOW_MS, DEFAULT_HTTP_RATE_LIMIT_WINDOW_MS, {
      min: 1_000,
    }),
    sessionTtlMs: parseInteger(process.env.MCP_HTTP_SESSION_TTL_MS, DEFAULT_HTTP_SESSION_TTL_MS, { min: 10_000 }),
    eventStoreFile: process.env.MCP_EVENT_STORE_FILE,
    enableJsonResponse: parseBool(process.env.MCP_HTTP_ENABLE_JSON_RESPONSE, false),
    trustProxy: parseBool(process.env.MCP_HTTP_TRUST_PROXY, false),
  };
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  if (res.headersSent) return;
  for (const [key, value] of Object.entries(headers ?? {})) {
    res.setHeader(key, value);
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${stableStringify(body)}\n`);
}

function sendMcpError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function sendAuthRequired(res: ServerResponse, config: HttpConfig, message: string): void {
  sendJson(
    res,
    401,
    { error: message },
    {
      "WWW-Authenticate": `Bearer realm="thalovant-mcp", resource_metadata="${config.resourceMetadataUrl.toString()}"`,
    },
  );
}

function protectedResourceMetadata(config: HttpConfig): Record<string, unknown> {
  return {
    resource: config.resourceUrl.toString(),
    authorization_servers: config.oauthAuthorizationServers,
    scopes_supported: config.oauthScopesSupported,
    bearer_methods_supported: ["header"],
    resource_name: "Thalovant MCP Server",
  };
}

function validateHost(req: IncomingMessage, config: HttpConfig): boolean {
  const host = req.headers.host?.toLowerCase();
  return Boolean(host && config.allowedHosts.map((allowed) => allowed.toLowerCase()).includes(host));
}

function applyCors(req: IncomingMessage, res: ServerResponse, config: HttpConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!config.allowedOrigins.includes(origin)) return false;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(url);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

function scopesFromClaim(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value.split(/[,\s]+/).filter(Boolean);
  }
  return [];
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function assertRequiredScopes(scopes: string[], requiredScopes: string[]): void {
  const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    throw new HttpError(403, `Missing required OAuth scope: ${missing.join(", ")}`);
  }
}

function assertAudience(audiences: string[], expectedAudience: string | undefined): void {
  if (!expectedAudience) return;
  if (!audiences.includes(expectedAudience)) {
    throw new HttpError(401, "Bearer token audience does not match this MCP resource server.");
  }
}

function authInfoFromAuthResult(auth: AuthResult): AuthInfo {
  return {
    token: auth.token ?? "",
    clientId: auth.clientId,
    scopes: auth.scopes,
    expiresAt: auth.expiresAt,
    resource: undefined,
    extra: {
      principalId: auth.userId,
      claims: auth.claims,
    },
  };
}

async function verifyJwtToken(token: string, config: HttpConfig): Promise<AuthResult> {
  if (!config.oauthJwksUrl) {
    throw new HttpError(500, "JWT verifier is not configured.");
  }
  try {
    const verifyOptions: Parameters<typeof jwtVerify>[2] = {
      issuer: config.oauthIssuer,
      audience: config.oauthAudience,
    };
    const { payload } = await jwtVerify(token, getJwks(config.oauthJwksUrl), verifyOptions);
    const scopes = Array.from(new Set([...scopesFromClaim(payload.scope), ...scopesFromClaim(payload.scp)]));
    assertRequiredScopes(scopes, config.oauthRequiredScopes);
    const clientId =
      (typeof payload.client_id === "string" && payload.client_id) ||
      (typeof payload.azp === "string" && payload.azp) ||
      "oauth-client";
    const userId = payload.sub ?? clientId;
    return {
      userId,
      clientId,
      scopes,
      token,
      expiresAt: payload.exp,
      claims: payload as JWTPayload,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Invalid OAuth JWT bearer token.");
  }
}

async function verifyIntrospectionToken(token: string, config: HttpConfig): Promise<AuthResult> {
  if (!config.oauthIntrospectionUrl) {
    throw new HttpError(500, "OAuth introspection verifier is not configured.");
  }
  const params = new URLSearchParams({ token });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (config.oauthClientId && config.oauthClientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${config.oauthClientId}:${config.oauthClientSecret}`).toString("base64")}`;
  } else if (config.oauthClientId) {
    params.set("client_id", config.oauthClientId);
  }

  const response = await fetch(config.oauthIntrospectionUrl, {
    method: "POST",
    headers,
    body: params,
  });
  if (!response.ok) {
    throw new HttpError(401, "OAuth token introspection failed.");
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (data.active !== true) {
    throw new HttpError(401, "Inactive OAuth bearer token.");
  }
  const scopes = scopesFromClaim(data.scope);
  assertRequiredScopes(scopes, config.oauthRequiredScopes);
  assertAudience(stringArray(data.aud), config.oauthAudience);
  const clientId =
    (typeof data.client_id === "string" && data.client_id) ||
    (typeof data.azp === "string" && data.azp) ||
    "oauth-client";
  const userId = (typeof data.sub === "string" && data.sub) || clientId;
  return {
    userId,
    clientId,
    scopes,
    token,
    expiresAt: typeof data.exp === "number" ? data.exp : undefined,
    claims: data,
  };
}

async function authenticate(req: IncomingMessage, config: HttpConfig): Promise<AuthResult> {
  const authorization = req.headers.authorization;
  const match = typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
  const providedToken = match?.[1];

  if (providedToken) {
    if (config.authMode === "static") {
      for (const token of config.authTokens) {
        if (safeEquals(providedToken, token)) {
          const userId = tokenFingerprint(token);
          return {
            userId,
            clientId: userId,
            scopes: config.oauthScopesSupported,
            token,
          };
        }
      }
      throw new HttpError(401, "Invalid bearer token.");
    }
    if (config.authMode === "jwt") {
      return verifyJwtToken(providedToken, config);
    }
    return verifyIntrospectionToken(providedToken, config);
  }

  if (config.allowUnauthenticated) {
    return { userId: "anonymous", clientId: "anonymous", scopes: ["anonymous"] };
  }

  throw new HttpError(401, "Missing bearer token.");
}

function clientAddress(req: IncomingMessage, config: HttpConfig): string {
  if (config.trustProxy) {
    const forwardedFor = req.headers["x-forwarded-for"];
    if (typeof forwardedFor === "string" && forwardedFor.trim()) {
      return forwardedFor.split(",")[0]?.trim() ?? "unknown";
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

function parseRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpError(413, "Request body too large.");
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function isInitializationBody(body: unknown): boolean {
  return isInitializeRequest(body) || (Array.isArray(body) && body.some((item) => isInitializeRequest(item)));
}

async function createEventStore(config: HttpConfig): Promise<EventStore> {
  return config.eventStoreFile ? FileEventStore.create(config.eventStoreFile) : new InMemoryEventStore();
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "thalovant",
    version: VERSION,
  });

  registerThalovantTool(server, 
    "thalovant_config_status",
    {
      title: "Thalovant Config Status",
      description: "Inspect local Thalovant MCP configuration without revealing secret values.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      jsonContent({
        apiUrl: process.env.THALOVANT_API_URL ?? DEFAULT_CONTROL_API_URL,
        hasAccessToken: Boolean(process.env.THALOVANT_ACCESS_TOKEN),
        hasEmailPassword: Boolean(process.env.THALOVANT_EMAIL && process.env.THALOVANT_PASSWORD),
        profile: process.env.THALOVANT_PROFILE,
        hasRuntimeEnvIdentity: Boolean(process.env.THALOVANT_ACCESS_KEY || process.env.THALOVANT_IDENTITY),
        defaultProtocol: "wss",
        secretHandling: "Secrets are redacted in tool output. Identity files are only written when savePath is provided.",
      }),
  );

  registerThalovantTool(server, 
    "thalovant_list_public_hubs",
    {
      title: "List Public Hubs",
      description: "List Thalovant public hubs. This read-only discovery call does not require authentication.",
      inputSchema: {
        limit: limitSchema,
        cursor: optionalCursorSchema,
        apiUrl: controlPlaneSchema.apiUrl,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, cursor, apiUrl }) => {
      const api = await createControlPlane({ apiUrl });
      return jsonContent(redactSecrets(await api.listPublicHubs({ limit, cursor })));
    },
  );

  registerThalovantTool(server, 
    "thalovant_get_public_hub",
    {
      title: "Get Public Hub",
      description: "Fetch one public Thalovant hub by id or slug.",
      inputSchema: {
        hubRef: z.string().min(1).describe("Public hub id or slug."),
        apiUrl: controlPlaneSchema.apiUrl,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ hubRef, apiUrl }) => {
      const api = await createControlPlane({ apiUrl });
      return jsonContent(redactSecrets(await api.getPublicHub(hubRef)));
    },
  );

  registerThalovantTool(server, 
    "thalovant_list_hubs",
    {
      title: "List Visible Hubs",
      description: "List authenticated Thalovant hubs visible to the account.",
      inputSchema: {
        ...controlPlaneSchema,
        limit: limitSchema,
        cursor: optionalCursorSchema,
        ownerId: z.string().min(1).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, cursor, ownerId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await api.listHubs({ limit, cursor, ownerId })));
    },
  );

  registerThalovantTool(server, 
    "thalovant_get_hub",
    {
      title: "Get Hub",
      description: "Fetch one authenticated Thalovant hub by id.",
      inputSchema: {
        ...controlPlaneSchema,
        hubId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ hubId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await api.getHub(hubId)));
    },
  );

  registerThalovantTool(server, 
    "thalovant_create_client_identity",
    {
      title: "Create Client Identity",
      description:
        "Create a Thalovant client identity for a hub. The identity is secret; output is redacted unless savePath is used.",
      inputSchema: {
        ...controlPlaneSchema,
        hubId: z.string().min(1).describe("Hub id or slug accepted by the Thalovant SDK."),
        name: z.string().min(1).max(128),
        siteId: z.string().min(1).optional(),
        ownerId: z.string().min(1).optional(),
        active: z.boolean().optional(),
        preferredProtocols: z.array(protocolSchema).min(1).default(["wss", "https"]),
        idempotencyKey: z.string().min(1).optional(),
        spec: jsonRecordSchema.optional(),
        savePath: z
          .string()
          .min(1)
          .optional()
          .describe("Optional local file path for the full secret identity JSON. File mode is set to 0600."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ hubId, name, siteId, ownerId, active, preferredProtocols, idempotencyKey, spec, savePath, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      const result = await api.createClientIdentity(hubId, {
        name,
        siteId,
        ownerId,
        active,
        preferredProtocols,
        idempotencyKey,
        spec,
      });
      const selectedEndpoint = api.requireRuntimeProtocol(result, preferredProtocols[0]);
      const savedIdentityPath = savePath ? await saveIdentity(savePath, result.identity) : undefined;
      return jsonContent({
        result: redactSecrets(result.asObject({ includeSecrets: false })),
        selectedEndpoint,
        enabledProtocols: result.identity.enabledProtocols(),
        savedIdentityPath,
        secretNotice: savedIdentityPath
          ? "Full identity was written to the requested local path with mode 0600."
          : "Secret identity fields were not returned. Pass savePath to write a protected local identity file.",
      });
    },
  );

  registerThalovantTool(server, 
    "thalovant_identity_status",
    {
      title: "Identity Status",
      description: "Load a Thalovant identity and return redacted protocol and endpoint status.",
      inputSchema: {
        ...runtimeAuthSchema,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const client = await createRuntimeClient(args);
      try {
        const identity = client.identity;
        return jsonContent({
          identity: redactSecrets(identity.asObject(false)),
          enabledProtocols: identity.enabledProtocols(),
          endpoints: redactSecrets(identity.dataPlaneEndpoints.asObject({ redactCredentials: true })),
          supportsRequestedProtocol: identity.supportsProtocol(args.protocol),
          health: client.healthcheck(),
        });
      } finally {
        await client.close();
      }
    },
  );

  registerThalovantTool(server, 
    "thalovant_healthcheck",
    {
      title: "Runtime Healthcheck",
      description: "Connect to a Thalovant hub with a saved identity and return runtime transport health.",
      inputSchema: {
        ...runtimeAuthSchema,
        timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).default(10_000),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ timeoutMs, ...runtime }) => {
      const client = await createRuntimeClient(runtime);
      try {
        await client.connect(clampTimeout(timeoutMs));
        return jsonContent(client.healthcheck());
      } finally {
        await client.close();
      }
    },
  );

  registerThalovantTool(server, 
    "thalovant_ask",
    {
      title: "Ask Hub",
      description: "Send one text request to a Thalovant hub using a saved identity and return the normalized reply.",
      inputSchema: {
        ...runtimeAuthSchema,
        text: z.string().min(1).max(20_000),
        timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
        lang: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
        requestId: z.string().min(1).optional(),
        context: contextSchema,
        replySettleMs: z.number().int().min(0).max(10_000).optional(),
        emptyReplyWaitMs: z.number().int().min(0).max(10_000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ text, timeoutMs, lang, sessionId, requestId, context, replySettleMs, emptyReplyWaitMs, ...runtime }) => {
      const client = await createRuntimeClient(runtime);
      try {
        const builtContext = context ? buildClientContext({}, context) : undefined;
        const reply = await client.ask(text, {
          timeoutMs: clampTimeout(timeoutMs),
          lang,
          sessionId,
          requestId,
          context: builtContext,
          replySettleMs,
          emptyReplyWaitMs,
        });
        return jsonContent(redactSecrets(summarizeReply(reply)));
      } finally {
        await client.close();
      }
    },
  );

  registerThalovantTool(server, 
    "thalovant_send_action",
    {
      title: "Send Action",
      description: "Send a structured action payload to a Thalovant hub.",
      inputSchema: {
        ...runtimeAuthSchema,
        payload: z.string().min(1).max(20_000),
        title: z.string().min(1).max(512).optional(),
        lang: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
        requestId: z.string().min(1).optional(),
        context: contextSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ payload, title, lang, sessionId, requestId, context, ...runtime }) => {
      const client = await createRuntimeClient(runtime);
      try {
        await client.sendAction(payload, {
          title,
          lang,
          sessionId,
          requestId,
          context: context ? buildClientContext({}, context) : undefined,
        });
        return textContent("Action sent.");
      } finally {
        await client.close();
      }
    },
  );

  registerThalovantTool(server, 
    "thalovant_send_code",
    {
      title: "Send Code",
      description: "Send an exact typed, scanned, barcode, QR, or serial value to a Thalovant hub.",
      inputSchema: {
        ...runtimeAuthSchema,
        value: z.string().min(1).max(20_000),
        kind: z.string().min(1).max(64).optional(),
        label: z.string().min(1).max(128).optional(),
        lang: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
        requestId: z.string().min(1).optional(),
        context: contextSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ value, kind, label, lang, sessionId, requestId, context, ...runtime }) => {
      const client = await createRuntimeClient(runtime);
      try {
        await client.sendCode(value, {
          kind,
          label,
          lang,
          sessionId,
          requestId,
          context: context ? buildClientContext({}, context) : undefined,
        });
        return textContent("Code sent.");
      } finally {
        await client.close();
      }
    },
  );

  registerThalovantTool(server, 
    "thalovant_emit_event",
    {
      title: "Emit Event",
      description: "Emit a raw Thalovant event to a hub. Use only when a more specific runtime tool is not enough.",
      inputSchema: {
        ...runtimeAuthSchema,
        eventType: z.string().min(1).max(256),
        data: jsonRecordSchema.default({}),
        context: contextSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ eventType, data, context, ...runtime }) => {
      const client = await createRuntimeClient(runtime);
      try {
        await client.emit(eventType, data, context ? buildClientContext({}, context) : undefined);
        return textContent("Event emitted.");
      } finally {
        await client.close();
      }
    },
  );

  registerThalovantTool(server, 
    "thalovant_wait_for_event",
    {
      title: "Wait For Event",
      description: "Wait for one named hub event using a saved identity.",
      inputSchema: {
        ...runtimeAuthSchema,
        eventName: z.string().min(1).max(256),
        timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
        sessionId: z.string().min(1).optional(),
        requestId: z.string().min(1).optional(),
        context: contextSchema,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ eventName, timeoutMs, sessionId, requestId, context, ...runtime }) => {
      const client = await createRuntimeClient(runtime);
      try {
        const event = await client.waitForEvent(eventName, {
          timeoutMs: clampTimeout(timeoutMs),
          sessionId,
          requestId,
          context: context ? buildClientContext({}, context) : undefined,
        });
        return jsonContent(redactSecrets(event.asObject()));
      } finally {
        await client.close();
      }
    },
  );

  registerThalovantTool(server, 
    "thalovant_get_analytics_overview",
    {
      title: "Analytics Overview",
      description: "Read authenticated Thalovant analytics overview data.",
      inputSchema: {
        ...controlPlaneSchema,
        admin: z.boolean().optional(),
        range: z.string().min(1).optional(),
        bucket: z.string().min(1).optional(),
        ownerId: z.string().min(1).optional(),
        hubId: z.string().min(1).optional(),
        clientId: z.string().min(1).optional(),
        country: z.string().min(1).optional(),
        message: z.string().min(1).optional(),
        utterance: z.string().min(1).optional(),
        intent: z.string().min(1).optional(),
        timeStart: z.string().min(1).optional(),
        timeEnd: z.string().min(1).optional(),
        weekday: z.number().int().min(0).max(6).optional(),
        hour: z.number().int().min(0).max(23).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { loginScope, apiUrl, ...filters } = args;
      const api = await createControlPlane({ loginScope, apiUrl });
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await api.getAnalyticsOverview(filters as AnalyticsOverviewOptions)));
    },
  );

  registerThalovantTool(server, 
    "thalovant_list_memory_items",
    {
      title: "List Memory Items",
      description: "List authenticated Thalovant memory items.",
      inputSchema: {
        ...controlPlaneSchema,
        scope: z.enum(["personal", "workspace", "hub"]).optional(),
        kind: z.enum(["note", "preference", "fact"]).optional(),
        ownerId: z.string().min(1).optional(),
        hubId: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
        includeDeleted: z.boolean().optional(),
        includeExpired: z.boolean().optional(),
        limit: limitSchema,
        offset: z.number().int().min(0).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { loginScope, apiUrl, ...filters } = args;
      const api = await createControlPlane({ loginScope, apiUrl });
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await api.listMemoryItems(filters as MemoryListOptions)));
    },
  );

  registerThalovantTool(server, 
    "thalovant_get_memory_summary",
    {
      title: "Memory Summary",
      description: "Read authenticated Thalovant memory summary data.",
      inputSchema: {
        ...controlPlaneSchema,
        ownerId: z.string().min(1).optional(),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ ownerId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await api.getMemorySummary({ ownerId })));
    },
  );

  registerThalovantTool(server, 
    "thalovant_get_memory_item",
    {
      title: "Get Memory Item",
      description: "Read one authenticated Thalovant memory item.",
      inputSchema: {
        ...controlPlaneSchema,
        memoryId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ memoryId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await api.getMemoryItem(memoryId)));
    },
  );

  registerThalovantTool(server, 
    "thalovant_create_memory_item",
    {
      title: "Create Memory Item",
      description: "Create an explicit Thalovant memory item.",
      inputSchema: {
        ...controlPlaneSchema,
        scope: z.enum(["personal", "workspace", "hub"]).optional(),
        kind: z.enum(["note", "preference", "fact"]).optional(),
        title: z.string().max(512).nullable().optional(),
        content: z.string().min(1).max(20_000),
        tags: z.array(z.string().min(1)).optional(),
        ownerId: z.string().min(1).optional(),
        hubId: z.string().min(1).optional(),
        source: z.string().min(1).optional(),
        metadata: jsonRecordSchema.optional(),
        consentScope: z.string().min(1).optional(),
        consentVersion: z.string().nullable().optional(),
        retentionPolicy: z.string().min(1).optional(),
        expiresAt: z.string().nullable().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { loginScope, apiUrl, ...payload } = args;
      const api = await createControlPlane({ loginScope, apiUrl });
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await api.createMemoryItem(payload as MemoryCreatePayload)));
    },
  );

  registerThalovantTool(server, 
    "thalovant_update_memory_item",
    {
      title: "Update Memory Item",
      description: "Update an explicit Thalovant memory item.",
      inputSchema: {
        ...controlPlaneSchema,
        memoryId: z.string().min(1),
        kind: z.enum(["note", "preference", "fact"]).optional(),
        title: z.string().max(512).nullable().optional(),
        content: z.string().min(1).max(20_000).optional(),
        tags: z.array(z.string().min(1)).optional(),
        metadata: jsonRecordSchema.optional(),
        consentScope: z.string().min(1).optional(),
        consentVersion: z.string().nullable().optional(),
        retentionPolicy: z.string().min(1).optional(),
        expiresAt: z.string().nullable().optional(),
        clearExpiresAt: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { loginScope, apiUrl, memoryId, ...payload } = args;
      const api = await createControlPlane({ loginScope, apiUrl });
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await api.updateMemoryItem(memoryId, payload as MemoryUpdatePayload)));
    },
  );

  registerThalovantTool(server, 
    "thalovant_delete_memory_item",
    {
      title: "Delete Memory Item",
      description: "Delete one Thalovant memory item.",
      inputSchema: {
        ...controlPlaneSchema,
        memoryId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ memoryId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      await api.deleteMemoryItem(memoryId);
      return textContent("Memory item deleted.");
    },
  );

  return server;
}

export async function startHttpServer(config = getHttpConfig()): Promise<{ close: () => Promise<void>; url: string }> {
  const sessions = new Map<string, SessionRecord>();
  const rateLimiter = new FixedWindowRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  const eventStore = await createEventStore(config);

  const closeSession = async (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await session.transport.close().catch((error: unknown) => {
      console.error("Error closing MCP HTTP transport:", error);
    });
    await session.server.close().catch((error: unknown) => {
      console.error("Error closing MCP HTTP server session:", error);
    });
  };

  const cleanupTimer = setInterval(() => {
    rateLimiter.cleanup();
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastSeen > config.sessionTtlMs) {
        void closeSession(sessionId);
      }
    }
  }, Math.min(config.sessionTtlMs, 60_000));
  cleanupTimer.unref();

  const httpServer = createHttpServer(async (req, res) => {
    setSecurityHeaders(res);

    try {
      if (!validateHost(req, config)) {
        sendJson(res, 403, { error: "Forbidden host." });
        return;
      }

      if (!applyCors(req, res, config)) {
        sendJson(res, 403, { error: "Forbidden origin." });
        return;
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = parseRequestUrl(req);
      if (url.pathname === "/healthz" || url.pathname === "/readyz") {
        sendJson(res, 200, {
          ok: true,
          name: "thalovant",
          version: VERSION,
          transport: "streamable-http",
        });
        return;
      }

      if (url.pathname === config.resourceMetadataUrl.pathname) {
        sendJson(res, 200, protectedResourceMetadata(config));
        return;
      }

      if (url.pathname !== config.path) {
        sendJson(res, 404, { error: "Not found." });
        return;
      }

      const rateKey = clientAddress(req, config);
      const rate = rateLimiter.check(rateKey);
      res.setHeader("RateLimit-Limit", String(config.rateLimitMax));
      res.setHeader("RateLimit-Remaining", String(rate.remaining));
      res.setHeader("RateLimit-Reset", String(Math.ceil(rate.resetAt / 1_000)));
      if (!rate.allowed) {
        sendJson(res, 429, { error: "Rate limit exceeded." }, { "Retry-After": String(Math.ceil(config.rateLimitWindowMs / 1_000)) });
        return;
      }

      const auth = await authenticate(req, config);
      const authenticatedReq = req as IncomingMessage & {
        auth?: AuthInfo;
      };
      authenticatedReq.auth = authInfoFromAuthResult(auth);
      authenticatedReq.auth.resource = config.resourceUrl;

      if (req.method === "POST") {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;

        if (sessionId) {
          const session = sessions.get(sessionId);
          if (!session) {
            sendMcpError(res, 404, -32001, "Unknown MCP session.");
            return;
          }
          if (session.userId !== auth.userId) {
            sendMcpError(res, 403, -32003, "MCP session is bound to a different authenticated principal.");
            return;
          }
          session.lastSeen = Date.now();
          await session.transport.handleRequest(authenticatedReq, res, body);
          return;
        }

        if (!isInitializationBody(body)) {
          sendMcpError(res, 400, -32000, "Bad Request: initialize is required before session requests.");
          return;
        }

        const mcpServer = createServer();
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore,
          enableJsonResponse: config.enableJsonResponse,
          enableDnsRebindingProtection: true,
          allowedHosts: config.allowedHosts,
          allowedOrigins: config.allowedOrigins,
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, {
              transport,
              server: mcpServer,
              userId: auth.userId,
              createdAt: Date.now(),
              lastSeen: Date.now(),
            });
          },
          onsessionclosed: (closedSessionId) => {
            sessions.delete(closedSessionId);
          },
        });
        transport.onerror = (error) => {
          console.error("MCP HTTP transport error:", error);
        };
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) {
            sessions.delete(closedSessionId);
          }
          void mcpServer.close().catch((error: unknown) => {
            console.error("Error closing MCP session server:", error);
          });
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(authenticatedReq, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
        if (!sessionId) {
          sendMcpError(res, 400, -32000, "Missing MCP session id.");
          return;
        }
        const session = sessions.get(sessionId);
        if (!session) {
          sendMcpError(res, 404, -32001, "Unknown MCP session.");
          return;
        }
        if (session.userId !== auth.userId) {
          sendMcpError(res, 403, -32003, "MCP session is bound to a different authenticated principal.");
          return;
        }
        session.lastSeen = Date.now();
        await session.transport.handleRequest(authenticatedReq, res);
        if (req.method === "DELETE") {
          await closeSession(sessionId);
        }
        return;
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      sendMcpError(res, 405, -32000, "Method not allowed.");
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 401) {
          sendAuthRequired(res, config, error.message);
          return;
        }
        sendJson(res, error.status, { error: error.message });
        return;
      }
      console.error("Error handling MCP HTTP request:", error);
      sendMcpError(res, 500, -32603, "Internal server error.");
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolveListen();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(config.port, config.host);
  });

  const url = `http://${config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host}:${config.port}${config.path}`;
  console.error(`Thalovant MCP Streamable HTTP listening at ${url}`);

  return {
    url,
    close: async () => {
      clearInterval(cleanupTimer);
      for (const sessionId of Array.from(sessions.keys())) {
        await closeSession(sessionId);
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        httpServer.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

export async function main() {
  const requestedTransport = process.argv.includes("--http")
    ? "http"
    : process.argv.includes("--stdio")
      ? "stdio"
      : (process.env.MCP_TRANSPORT ?? "stdio");

  if (requestedTransport === "http" || requestedTransport === "streamable-http") {
    await startHttpServer();
    return;
  }

  const transport = new StdioServerTransport();
  const server = createServer();
  await server.connect(transport);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error("Fatal error in thalovant-mcp:", error);
    process.exit(1);
  });
}
