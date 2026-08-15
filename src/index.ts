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
  HubPayload,
  HubProtocol,
  IdentityInput,
  MemoryCreatePayload,
  MemoryListOptions,
  MemoryUpdatePayload,
  ReleaseOptions,
  RuntimeGroupPayload,
  RuntimeGroupSkillInstallOptions,
  ThalovantDisplayItem,
  ThalovantReply,
} from "@thalovant/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { realpathSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { z } from "zod";

const VERSION = "0.1.10";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_LIMIT = 100;
const MAX_PUBLIC_HUBS_LIMIT = 48;
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
  "device_code",
  "deviceCode",
  "user_code",
  "userCode",
  "authToken",
  "authorization",
  "bearer",
  "jwt",
  "psk",
  "cert",
  "token",
  "secret",
];

const protocolSchema = z.enum(["wss", "https", "mqtt"]);
const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(25).describe("Page size, 1-100.");
const publicHubsLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_PUBLIC_HUBS_LIMIT)
  .default(25)
  .describe("Page size, 1-48. The public hubs endpoint caps page size at 48.");
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

/**
 * Tools that destroy control-plane resources. They are never registered unless
 * an operator opts in with THALOVANT_ENABLE_DESTRUCTIVE_TOOLS, so by default
 * they are absent from tools/list entirely rather than merely failing when
 * called. See destructiveToolsEnabled().
 */
const DESTRUCTIVE_TOOLS = ["thalovant_delete_hub", "thalovant_delete_runtime_group"] as const;

/**
 * Destructive control-plane tools are opt-in.
 *
 * The per-principal tool policy in authorizeTool() is an allow/deny filter
 * evaluated at call time: an empty allowlist means "allow everything", so it
 * cannot express a tool that is off until an operator turns it on, and it
 * cannot hide a tool from tools/list. A long-lived token plus an always-listed
 * delete tool is a categorically different risk from a read or update tool, so
 * these two are gated at registration time by this env flag instead. When the
 * flag is on they are registered like any other tool and remain subject to the
 * global and per-principal policy, which can still deny them.
 */
function destructiveToolsEnabled(): boolean {
  return parseBool(process.env.THALOVANT_ENABLE_DESTRUCTIVE_TOOLS, false);
}

/**
 * Non-catalog skill sources are opt-in.
 *
 * thalovant_install_runtime_group_skill can install a skill from a source other
 * than the vetted marketplace catalog — notably `sourceType: "git"` with an
 * arbitrary `sourceRef` repository URL. The control-plane validator is
 * format-only with no host allowlist, so any non-catalog source is effectively
 * an arbitrary-code-into-the-runtime primitive. Because this server hands its
 * tools to an LLM holding a long-lived token, that primitive is refused by
 * default and only enabled when an operator opts in with this flag, mirroring
 * the THALOVANT_ENABLE_DESTRUCTIVE_TOOLS gate. Installing from the catalog (the
 * default source) is always allowed.
 */
function gitSkillSourcesEnabled(): boolean {
  return parseBool(process.env.THALOVANT_ENABLE_GIT_SKILL_SOURCES, false);
}

/** The default install source is the vetted marketplace catalog. */
function isCatalogSource(sourceType: string | undefined): boolean {
  return !sourceType || sourceType.trim().toLowerCase() === "catalog";
}

/**
 * Read-only mode.
 *
 * When THALOVANT_MCP_READONLY is set, only tools annotated readOnlyHint: true
 * are registered, so an operator can run a safe agent without hand-writing a
 * tool denylist. Non-read-only tools are never registered and so never appear
 * in tools/list. This complements, and is independent of, the per-principal
 * allow/deny policy in authorizeTool().
 */
function readOnlyModeEnabled(): boolean {
  return parseBool(process.env.THALOVANT_MCP_READONLY, false);
}

const capacityProfileSchema = z
  .enum(["standard", "autoscaling"])
  .describe(
    'Hub capacity profile. Only "standard" (the API default, 1 replica) and "autoscaling" (2-32 replicas) are accepted. Omit the key entirely rather than sending null — an explicit null fails 422 INVALID_HUB_CAPACITY_PROFILE. "autoscaling" is plan-gated: 403 HUB_AUTOSCALING_NOT_INCLUDED when the plan has no autoscaling, 409 AUTOSCALING_HUB_LIMIT_REACHED when its autoscaling slots are already used.',
  );

const hubSpecSchema = z
  .object({ version: z.string().min(1).describe("Required. Hub spec version, e.g. \"1\".") })
  .passthrough()
  .describe(
    'Hub spec object. `version` is REQUIRED and must be a non-empty string — {"version": "1"} is the minimum valid spec; omitting it fails 422 "Schema validation failed". Other keys pass through, and the API injects defaults for replicas, resources, catalog, and protocols.',
  );

const hubEtagSchema = z
  .string()
  .min(1)
  .describe(
    "Required. The hub's current etag, sent as If-Match for optimistic locking. Read it from the `etag` field in the hub resource BODY returned by thalovant_get_hub — the API does not send an ETag response header, so you must fetch the hub first. A missing or stale value fails with HTTP 412 and changes nothing: re-fetch the hub, take the new etag, and retry.",
  );

const runtimeGroupResourceLimitsSchema = z
  .object({
    requests: z.record(z.string()).optional(),
    limits: z.record(z.string()).optional(),
  })
  .optional();

const runtimeGroupSpecSchema = z
  .object({
    replicas: z.number().int().min(1).max(20).optional().describe("Replica count, 1-20."),
    resources: z
      .object({
        core: runtimeGroupResourceLimitsSchema,
        messagebus: runtimeGroupResourceLimitsSchema,
      })
      .optional()
      .describe("Container resource requests/limits, as string-valued maps (for example {\"cpu\": \"500m\"})."),
  })
  .describe("Patches replicas and container resources only. Note the replica ceiling here is 20, separate from a hub's autoscaling ceiling of 32.");

const releaseOptionsSchema = {
  channel: z.string().min(1).optional().describe("Release channel. Falls back to the workspace release policy when omitted."),
  mode: z.string().min(1).optional().describe('Release mode. Passing images without mode switches to "custom".'),
  version: z.string().min(1).optional().describe("Pinned release version."),
  images: z.record(z.string().min(1)).optional().describe("Explicit image overrides. Switches to custom mode unless mode is also set."),
  reason: z.string().min(1).optional().describe("Audit reason recorded with the release."),
};

function releaseOptionsFrom(args: {
  channel?: string;
  mode?: string;
  version?: string;
  images?: Record<string, string>;
  reason?: string;
}): ReleaseOptions {
  return { channel: args.channel, mode: args.mode, version: args.version, images: args.images, reason: args.reason };
}

/** Which failure modes a control-plane call can produce, for error guidance. */
type ControlPlaneErrorProfile = "read" | "write" | "hubWrite" | "skillInstall";

const SCOPE_HINT_403 =
  'HTTP 403 "Insufficient scopes" — the token lacks the scope this route needs: hubs:write for provisioning, hubs:read for the marketplace catalog, hubs:inspect for runtime-group and hub runtime views (hubs:write implies hubs:read, which implies hubs:inspect and hubs:preview). The API checks scope BEFORE the paid-plan gate, so a 403 can mask a plan problem and granting the scope may surface a 402 next. Free-plan API tokens are capped at hubs:read, clients:read, and clients:write, so a free-tier API token fails provisioning with this 403 and never reaches the 402. A 403 here can also mean the caller does not own the resource ("Ownership required"), or a plan restriction such as HUB_AUTOSCALING_NOT_INCLUDED or a custom hub domain the plan does not allow.';

const PLAN_HINT_402 =
  'HTTP 402 "API access requires a paid plan." — the token is valid and correctly scoped but the tenant is on the free plan. Free-tier callers can browse the catalog (thalovant_list_marketplace_skills) and set hub ratings, but cannot create, update, release, or delete hubs and runtime groups, and cannot install skills.';

const MARKETPLACE_HINT_402 =
  'HTTP 402 "This skill requires paid marketplace access for the tenant plan." — a DIFFERENT 402 from the plan gate: the plan is paid enough to provision, but this catalog entry has access_tier "paid" and the plan does not include paid marketplace skills. thalovant_list_runtime_group_marketplace reports this per skill as purchase_required, installable, and access_message; check it before installing.';

const ETAG_HINT_412 =
  'HTTP 412 "ETag mismatch" — the If-Match etag was missing or stale and nothing changed. Re-fetch the hub with thalovant_get_hub, read the `etag` field from the response BODY (there is no ETag response header), and retry with that exact value. The comparison is exact string equality, so do not rewrite or weaken the value.';

function controlPlaneErrorHint(profile: ControlPlaneErrorProfile, status: number, body: string): string | undefined {
  switch (status) {
    case 402:
      return profile === "skillInstall" && /marketplace/i.test(body) ? MARKETPLACE_HINT_402 : PLAN_HINT_402;
    case 403:
      return SCOPE_HINT_403;
    case 409:
      if (profile === "hubWrite") {
        return 'HTTP 409 — for a hub create this is either a duplicate ("Hub with name ... already exists for this owner" / "Hub slug ... already exists"), an autoscaling slot limit (AUTOSCALING_HUB_LIMIT_REACHED), or "Idempotency key re-used with different payload". Only hub create honors Idempotency-Key: retrying an identical create is safe and returns the original hub, but reusing a key with a changed body conflicts — use a new idempotencyKey for a genuinely different hub.';
      }
      return "HTTP 409 — the resource is not in a state that allows this call: a hub with no connected client cannot report runtime capabilities, a runtime group cannot be deleted while it is the workspace default or still has hubs attached, and a deactivated marketplace skill cannot be installed.";
    case 412:
      return ETAG_HINT_412;
    default:
      return undefined;
  }
}

/**
 * Run a control-plane call and, on failure, append actionable guidance.
 *
 * The SDK raises ThalovantApiError with the status embedded in the message
 * ("Thalovant API request failed with HTTP 412: ..."), so the status is
 * recovered by parsing rather than from a structured field.
 */
async function callControlPlane<T>(profile: ControlPlaneErrorProfile, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(/HTTP (\d{3})/.exec(message)?.[1]);
    const hint = Number.isFinite(status) ? controlPlaneErrorHint(profile, status, message) : undefined;
    if (!hint) throw error;
    throw new Error(`${message}\n\n${hint}`);
  }
}

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
  if (readOnlyModeEnabled()) {
    const annotations = (config.annotations ?? {}) as { readOnlyHint?: boolean };
    if (annotations.readOnlyHint !== true) {
      // Read-only mode: do not register write/destructive tools at all.
      return;
    }
  }
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
  const accessToken =
    credential?.control?.accessToken ??
    (canUseShared ? process.env.THALOVANT_API_TOKEN ?? process.env.THALOVANT_ACCESS_TOKEN : undefined);
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
      "This tool requires Thalovant API auth. Configure THALOVANT_API_TOKEN (recommended: a scoped, revocable API token), THALOVANT_ACCESS_TOKEN, THALOVANT_EMAIL/THALOVANT_PASSWORD, or per-principal Thalovant credentials for this MCP principal.",
    );
  }
}

type ControlPlaneAuthMode = "api-token" | "access-token" | "email-password" | "none";

function controlPlaneAuthModeFromEnv(): ControlPlaneAuthMode {
  if (process.env.THALOVANT_API_TOKEN) return "api-token";
  if (process.env.THALOVANT_ACCESS_TOKEN) return "access-token";
  if (process.env.THALOVANT_EMAIL && process.env.THALOVANT_PASSWORD) return "email-password";
  return "none";
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

/**
 * Base directory that saved client-identity files are confined to.
 *
 * thalovant_create_client_identity takes an LLM-chosen savePath. The file is
 * written 0600, but without a base directory the model controls WHERE the
 * secret lands and could drop a credential file into a git working tree or a
 * synced folder. Files are therefore confined to THALOVANT_MCP_IDENTITY_DIR,
 * defaulting to an `identities` folder under the Thalovant SDK config dir
 * ($XDG_CONFIG_HOME/thalovant, %APPDATA%/Thalovant on Windows, else
 * ~/.config/thalovant), matching the SDK's own convention.
 */
function identityBaseDir(): string {
  const override = process.env.THALOVANT_MCP_IDENTITY_DIR?.trim();
  if (override) return resolve(override);
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "thalovant", "identities");
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "Thalovant", "identities");
  return join(homedir(), ".config", "thalovant", "identities");
}

/**
 * Resolve an LLM-supplied savePath against the identity base directory and
 * refuse anything that escapes it. Relative paths resolve inside the base dir;
 * absolute paths and `..` traversal that land outside it are rejected. The base
 * dir is realpath'd so a symlinked base still validates correctly.
 */
function resolveIdentityPath(savePath: string): string {
  const baseDir = identityBaseDir();
  let canonicalBase = resolve(baseDir);
  try {
    canonicalBase = realpathSync(canonicalBase);
  } catch {
    // Base dir does not exist yet; writeIdentityFile creates it. Use the resolved
    // (non-canonical) path for containment — nothing is symlinked yet.
  }
  const candidate = resolve(canonicalBase, savePath);
  const rel = relative(canonicalBase, candidate);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `savePath must resolve to a location inside the identity directory (${canonicalBase}). ` +
        `Absolute paths outside it and ".." traversal are rejected; pass a plain filename such as "my-hub.json". ` +
        `Set THALOVANT_MCP_IDENTITY_DIR to change the identity directory.`,
    );
  }
  return candidate;
}

async function writeIdentityFile(resolvedPath: string, identity: ThalovantIdentity): Promise<string> {
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
        controlPlaneAuthMode: controlPlaneAuthModeFromEnv(),
        hasApiToken: Boolean(process.env.THALOVANT_API_TOKEN),
        hasAccessToken: Boolean(process.env.THALOVANT_ACCESS_TOKEN),
        hasEmailPassword: Boolean(process.env.THALOVANT_EMAIL && process.env.THALOVANT_PASSWORD),
        profile: process.env.THALOVANT_PROFILE,
        hasRuntimeEnvIdentity: Boolean(process.env.THALOVANT_ACCESS_KEY || process.env.THALOVANT_IDENTITY),
        defaultProtocol: "wss",
        destructiveToolsEnabled: destructiveToolsEnabled(),
        destructiveTools: destructiveToolsEnabled() ? [...DESTRUCTIVE_TOOLS] : [],
        gitSkillSourcesEnabled: gitSkillSourcesEnabled(),
        readOnly: readOnlyModeEnabled(),
        identityDir: identityBaseDir(),
        secretHandling:
          "Secrets are redacted in tool output. Identity files are only written when savePath is provided, and only inside identityDir.",
      }),
  );

  registerThalovantTool(server, 
    "thalovant_list_public_hubs",
    {
      title: "List Public Hubs",
      description:
        "List Thalovant public hubs. This read-only discovery call does not require authentication. Page size is capped at 48.",
      inputSchema: {
        limit: publicHubsLimitSchema,
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
      description: "Fetch one authenticated Thalovant hub by UUID.",
      inputSchema: {
        ...controlPlaneSchema,
        hubId: z
          .string()
          .min(1)
          .describe("Hub UUID. This authenticated route rejects slugs; slugs are only accepted by the public hub tools (thalovant_get_public_hub)."),
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
        hubId: z
          .string()
          .min(1)
          .describe("Hub UUID. This authenticated route rejects slugs; slugs are only accepted by the public hub tools (thalovant_get_public_hub)."),
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
          .describe(
            "Optional filename for the full secret identity JSON, written 0600 inside the server's identity directory (see identityDir in thalovant_config_status). Pass a plain filename like \"my-hub.json\"; absolute paths outside the identity directory and \"..\" traversal are rejected.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ hubId, name, siteId, ownerId, active, preferredProtocols, idempotencyKey, spec, savePath, ...auth }) => {
      // Validate the destination BEFORE creating a cloud identity, so a path
      // that escapes the identity directory is refused without leaving an
      // orphaned credential behind in the control plane.
      const targetIdentityPath = savePath ? resolveIdentityPath(savePath) : undefined;
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
      const savedIdentityPath = targetIdentityPath ? await writeIdentityFile(targetIdentityPath, result.identity) : undefined;
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
        return jsonContent(redactSecrets(client.healthcheck()));
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
        range: z.string().min(1).optional(),
        bucket: z.string().min(1).optional(),
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
        query: z.string().min(1).max(240).optional(),
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
        title: z.string().max(160).nullable().optional(),
        content: z.string().min(1).max(4_096),
        tags: z.array(z.string().min(1)).optional(),
        ownerId: z.string().min(1).optional(),
        hubId: z.string().min(1).optional(),
        source: z.string().min(1).max(64).optional(),
        metadata: jsonRecordSchema.optional(),
        consentScope: z.string().min(1).max(128).optional(),
        consentVersion: z.string().max(64).nullable().optional(),
        retentionPolicy: z.string().min(1).max(64).optional(),
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
        title: z.string().max(160).nullable().optional(),
        content: z.string().min(1).max(4_096).optional(),
        tags: z.array(z.string().min(1)).optional(),
        metadata: jsonRecordSchema.optional(),
        consentScope: z.string().min(1).max(128).optional(),
        consentVersion: z.string().max(64).nullable().optional(),
        retentionPolicy: z.string().min(1).max(64).optional(),
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

  registerThalovantTool(server,
    "thalovant_list_marketplace_skills",
    {
      title: "List Marketplace Skills",
      description:
        "Browse the Thalovant marketplace skill catalog. Start here when discovering what a hub could run: each entry carries the fields an install needs (skill_id, source_type, source_ref, package_name, version compatibility, config_schema, secret_schema) plus category, tags, verified, access_tier, and billing_sku. Requires the hubs:read scope and is NOT paid-gated, so a free-tier token can browse the catalog even though it cannot install from it. The response is not paginated — the whole catalog comes back at once.",
      inputSchema: {
        ...controlPlaneSchema,
        ownerId: z
          .string()
          .min(1)
          .optional()
          .describe("Admin tokens only. A non-admin caller is silently scoped to their own tenant instead of being rejected, so this is a no-op for ordinary tokens."),
        includeInactive: z
          .boolean()
          .optional()
          .describe("Admin tokens only. A non-admin caller silently gets active entries only, with no error."),
        forceRefresh: z
          .boolean()
          .optional()
          .describe("Re-sync the global catalog from its source before answering. Open to all callers; noticeably slower."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ ownerId, includeInactive, forceRefresh, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(
        redactSecrets(await callControlPlane("read", () => api.listMarketplaceSkills({ ownerId, includeInactive, forceRefresh }))),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_list_runtime_group_marketplace",
    {
      title: "List Runtime Group Marketplace",
      description:
        "List the marketplace catalog resolved against one runtime group. This is the view to read immediately before installing: every catalog entry comes back with the group's own state folded in — whether the skill is desired (active, version_pin, source_type), whether it was observed running (observed_source, observed_at, intent counts), operator status, and the plan verdict (purchase_required, installable, access_message). Check installable and purchase_required here to avoid a 402 at install time. Requires the hubs:inspect scope; browsing needs no paid plan. Answers 404 for an unknown group and 403 when the caller does not own it.",
      inputSchema: {
        ...controlPlaneSchema,
        runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
        refreshInventory: z
          .boolean()
          .optional()
          .describe("Force a live read from the runtime operator. Without it the envelope source is runtime-group-cache (or runtime-group-cache-empty), never a live read."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ runtimeGroupId, refreshInventory, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(
        redactSecrets(await callControlPlane("read", () => api.listRuntimeGroupMarketplace(runtimeGroupId, { refreshInventory }))),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_list_runtime_group_inventory",
    {
      title: "List Runtime Group Inventory",
      description:
        "List the skills a runtime group is actually observed running right now. Where thalovant_list_runtime_group_marketplace answers 'what could be installed here', this answers 'what is loaded'. Each entry carries skill_id, version, source, active, adapt_intents, padatious_intents, total_intents, and observed_at; the envelope reports source (ovos-runtime-operator, runtime-group-cache, or ovos-runtime-operator-pending), operator_phase, and operator_message. Unlike thalovant_get_hub_runtime_capabilities this never fails with 409 when nothing is reporting — it returns an empty list with a pending source. Requires the hubs:inspect scope; no paid plan needed.",
      inputSchema: {
        ...controlPlaneSchema,
        runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
        refresh: z
          .boolean()
          .optional()
          .describe("Force a live operator read. The API also refreshes on its own when it holds no cached snapshot."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ runtimeGroupId, refresh, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(
        redactSecrets(await callControlPlane("read", () => api.listRuntimeGroupInventory(runtimeGroupId, { refresh }))),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_create_hub",
    {
      title: "Create Hub",
      description:
        "Create a Thalovant hub. Requires the hubs:write scope AND a paid plan: a token without the scope fails 403, and because the scope is checked before the plan, granting the scope can then surface a 402 'API access requires a paid plan'. The create is idempotent — the SDK sends an Idempotency-Key, so a retried create returns the first hub rather than making a second one; reusing a key with a DIFFERENT body fails 409.",
      inputSchema: {
        ...controlPlaneSchema,
        name: z.string().min(1).max(128).describe("Hub name, 1-128 characters. Required. Immutable once created."),
        spec: hubSpecSchema,
        slug: z
          .string()
          .min(1)
          .max(191)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric segments separated by single hyphens.")
          .optional()
          .describe("1-191 chars, lowercase alphanumeric segments separated by single hyphens. Defaults to a slug derived from name. Unlike name, slug stays mutable."),
        namespace: z.string().min(1).max(128).optional().describe("1-128 characters. Resolved server-side when omitted. Immutable once created."),
        domain: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Max 255 characters. Immutable once created. Plans without custom domains are rejected with 403; when omitted, a managed subdomain is generated if the plan provides one."),
        active: z.boolean().optional().describe("Defaults to true."),
        visibility: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe('1-32 characters, defaults to "private". Only "public" is special-cased by the API, and public listing is plan-gated.'),
        ownerId: z.string().min(1).optional().describe("Defaults to the caller. Setting another owner requires admin."),
        runtimeGroupId: z.string().min(1).optional().describe("Runtime group UUID to attach the hub to."),
        capacityProfile: capacityProfileSchema.optional(),
        isLocked: z.boolean().optional(),
        idempotencyKey: z
          .string()
          .min(1)
          .optional()
          .describe("Reuse the same key to safely retry one create. Reusing it with a different body fails 409."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { loginScope, apiUrl, idempotencyKey, ...payload } = args;
      const api = await createControlPlane({ loginScope, apiUrl });
      ensureAuthenticated(api);
      return jsonContent(
        redactSecrets(await callControlPlane("hubWrite", () => api.createHub(payload as HubPayload, { idempotencyKey }))),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_update_hub",
    {
      title: "Update Hub",
      description:
        "Partially update a Thalovant hub. Send ONLY the fields you are changing — do not round-trip a whole hub resource. name, namespace, and domain are immutable and are deliberately not accepted here; the API rejects a changed value with HTTP 400. This route uses optimistic locking and requires the hub's current etag, which lives in the hub resource BODY (there is no ETag response header), so call thalovant_get_hub first and pass the etag field from its response. A missing or stale etag fails 412 and changes nothing. Requires the hubs:write scope and a paid plan.",
      inputSchema: {
        ...controlPlaneSchema,
        hubId: z.string().min(1).describe("Hub UUID. This authenticated route rejects slugs."),
        etag: hubEtagSchema,
        active: z.boolean().optional(),
        visibility: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe('1-32 characters. Switching to "public" is plan-gated and fails 403 on plans that keep hubs private.'),
        slug: z
          .string()
          .min(1)
          .max(191)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumeric segments separated by single hyphens.")
          .optional()
          .describe("Mutable, unlike name/namespace/domain. Fails 409 if the slug is already taken."),
        spec: hubSpecSchema.optional(),
        ownerId: z.string().min(1).optional(),
        runtimeGroupId: z.string().min(1).optional(),
        capacityProfile: capacityProfileSchema.optional(),
        isLocked: z.boolean().optional().describe("Admin only: a non-admin gets 403, and a non-admin cannot update a locked hub at all."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { loginScope, apiUrl, hubId, etag, ...payload } = args;
      const api = await createControlPlane({ loginScope, apiUrl });
      ensureAuthenticated(api);
      return jsonContent(
        redactSecrets(await callControlPlane("hubWrite", () => api.updateHub(hubId, payload as HubPayload, { etag }))),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_release_hub",
    {
      title: "Release Hub",
      description:
        "Apply a release policy to a hub and return the updated hub. Every option is optional; omitted fields fall back to the workspace release policy. Passing images switches the hub to custom mode unless mode is also set. Requires the hubs:write scope and a paid plan. No etag is needed.",
      inputSchema: {
        ...controlPlaneSchema,
        hubId: z.string().min(1).describe("Hub UUID."),
        ...releaseOptionsSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ hubId, channel, mode, version, images, reason, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(
        redactSecrets(
          await callControlPlane("hubWrite", () =>
            api.releaseHub(hubId, releaseOptionsFrom({ channel, mode, version, images, reason })),
          ),
        ),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_set_hub_rating",
    {
      title: "Set Hub Rating",
      description:
        'Rate a public Thalovant hub from 1 to 5 and return the updated hub. Requires the hubs:write scope; no paid plan is needed, so free-tier tokens can rate. Rating a non-public hub fails 400 "Only public hubs can be rated." and rating your own hub fails 400 "Hub owners cannot rate their own public hubs."',
      inputSchema: {
        ...controlPlaneSchema,
        hubId: z.string().min(1).describe("Hub UUID."),
        rating: z.number().int().min(1).max(5).describe("Rating, an integer from 1 to 5."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ hubId, rating, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await callControlPlane("write", () => api.setHubRating(hubId, rating))));
    },
  );

  registerThalovantTool(server,
    "thalovant_clear_hub_rating",
    {
      title: "Clear Hub Rating",
      description:
        "Remove the caller's own rating from a public Thalovant hub and return the hub. This clears only the caller's rating, not the hub. Requires the hubs:write scope; no paid plan is needed.",
      inputSchema: {
        ...controlPlaneSchema,
        hubId: z.string().min(1).describe("Hub UUID."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ hubId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await callControlPlane("write", () => api.clearHubRating(hubId))));
    },
  );

  registerThalovantTool(server,
    "thalovant_get_hub_runtime_capabilities",
    {
      title: "Get Hub Runtime Capabilities",
      description:
        "Read the live skill and intent inventory a hub runtime exposes. Requires the hubs:inspect scope. The API answers HTTP 409 when the hub has no connected client that can report inventory — for a group-level view that returns an empty list instead of failing, use thalovant_list_runtime_group_inventory.",
      inputSchema: {
        ...controlPlaneSchema,
        hubId: z.string().min(1).describe("Hub UUID."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ hubId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await callControlPlane("read", () => api.getHubRuntimeCapabilities(hubId))));
    },
  );

  registerThalovantTool(server,
    "thalovant_list_runtime_groups",
    {
      title: "List Runtime Groups",
      description:
        "List the Thalovant runtime groups visible to the authenticated account. Requires the hubs:read scope. The response is not paginated — every visible group is returned at once.",
      inputSchema: {
        ...controlPlaneSchema,
        ownerId: z
          .string()
          .min(1)
          .optional()
          .describe("Admin tokens only. Unlike the marketplace catalog, which silently ignores this for non-admins, passing another account's id here fails 403 \"Ownership required\". Omit it to list your own groups."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ ownerId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await callControlPlane("read", () => api.listRuntimeGroups({ ownerId }))));
    },
  );

  registerThalovantTool(server,
    "thalovant_get_runtime_group",
    {
      title: "Get Runtime Group",
      description: "Fetch one Thalovant runtime group. Requires the hubs:read scope.",
      inputSchema: {
        ...controlPlaneSchema,
        runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ runtimeGroupId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await callControlPlane("read", () => api.getRuntimeGroup(runtimeGroupId))));
    },
  );

  registerThalovantTool(server,
    "thalovant_create_runtime_group",
    {
      title: "Create Runtime Group",
      description:
        "Create a Thalovant runtime group — the unit that hosts hubs and holds installed skills. Requires the hubs:write scope and a paid plan. Unlike the hub write routes this one takes no etag.",
      inputSchema: {
        ...controlPlaneSchema,
        name: z.string().min(1).max(128).describe("Runtime group name, 1-128 characters. Required."),
        description: z.string().max(255).optional().describe("Max 255 characters."),
        environment: z.string().min(1).max(32).optional().describe("1-32 characters. Lowercased server-side; defaults from server settings."),
        ownerId: z.string().min(1).optional().describe("Defaults to the caller. Setting another owner requires admin."),
        cloneFromDefault: z
          .boolean()
          .optional()
          .describe("Seed the new group from the workspace default group instead of starting empty."),
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
      return jsonContent(
        redactSecrets(await callControlPlane("write", () => api.createRuntimeGroup(payload as RuntimeGroupPayload))),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_update_runtime_group",
    {
      title: "Update Runtime Group",
      description:
        "Update a Thalovant runtime group's name, description, or spec. spec patches replicas and container resources. This route does NOT use If-Match, so no etag is required. Requires the hubs:write scope and a paid plan.",
      inputSchema: {
        ...controlPlaneSchema,
        runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
        name: z.string().min(1).max(128).optional().describe("1-128 characters."),
        description: z.string().max(255).optional().describe("Max 255 characters."),
        spec: runtimeGroupSpecSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { loginScope, apiUrl, runtimeGroupId, ...payload } = args;
      const api = await createControlPlane({ loginScope, apiUrl });
      ensureAuthenticated(api);
      return jsonContent(
        redactSecrets(
          await callControlPlane("write", () => api.updateRuntimeGroup(runtimeGroupId, payload as RuntimeGroupPayload)),
        ),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_get_runtime_group_config",
    {
      title: "Get Runtime Group Config",
      description:
        "Read a Thalovant runtime group's runtime configuration and personas. Requires the hubs:read scope. Read this before thalovant_update_runtime_group_config so you know what the merge will land on.",
      inputSchema: {
        ...controlPlaneSchema,
        runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ runtimeGroupId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(redactSecrets(await callControlPlane("read", () => api.getRuntimeGroupConfig(runtimeGroupId))));
    },
  );

  registerThalovantTool(server,
    "thalovant_update_runtime_group_config",
    {
      title: "Update Runtime Group Config",
      description:
        "Merge runtime configuration into a Thalovant runtime group. The API MERGES config into the stored configuration rather than replacing it, and marks the group pending so the runtime operator reconciles the change. personas, when provided, is REPLACED wholesale rather than merged; omit it to leave stored personas untouched. Requires the hubs:write scope and a paid plan.",
      inputSchema: {
        ...controlPlaneSchema,
        runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
        config: jsonRecordSchema.describe("Configuration object merged into the stored configuration. Required."),
        personas: jsonRecordSchema.optional().describe("Replaces the stored personas outright. Left untouched when omitted."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ runtimeGroupId, config, personas, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(
        redactSecrets(await callControlPlane("write", () => api.updateRuntimeGroupConfig(runtimeGroupId, config, { personas }))),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_release_runtime_group",
    {
      title: "Release Runtime Group",
      description:
        "Apply a runtime image policy to a Thalovant runtime group and return the updated group. Options behave like thalovant_release_hub: everything is optional, omitted fields fall back to the workspace release policy, and passing images switches to custom mode unless mode is also set. Requires the hubs:write scope and a paid plan.",
      inputSchema: {
        ...controlPlaneSchema,
        runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
        ...releaseOptionsSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ runtimeGroupId, channel, mode, version, images, reason, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      return jsonContent(
        redactSecrets(
          await callControlPlane("write", () =>
            api.releaseRuntimeGroup(runtimeGroupId, releaseOptionsFrom({ channel, mode, version, images, reason })),
          ),
        ),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_install_runtime_group_skill",
    {
      title: "Install Runtime Group Skill",
      description:
        "Install (or re-install) a skill in a Thalovant runtime group from the marketplace catalog. Installing a skill that is already present updates the existing entry rather than failing. Discover skillId with thalovant_list_marketplace_skills, then confirm installable/purchase_required with thalovant_list_runtime_group_marketplace before calling this. Requires the hubs:write scope and a paid plan (402 'API access requires a paid plan'); a paid marketplace skill ALSO needs marketplace access on the tenant plan, which fails with a second, distinct 402 about paid marketplace access. Only catalog sources are allowed by default: installing from a non-catalog source such as sourceType \"git\" runs code the marketplace never vetted and is refused unless the operator sets THALOVANT_ENABLE_GIT_SKILL_SOURCES.",
      inputSchema: {
        ...controlPlaneSchema,
        runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
        skillId: z
          .string()
          .min(1)
          .max(191)
          .describe("Skill id from the catalog, 1-191 characters. Sent as skill_id in the request BODY on install (it is a path segment only on uninstall). For a catalog install the API persists the resolved catalog id, which may differ from what you send."),
        marketplaceSkillId: z.string().uuid().optional().describe("Catalog entry UUID, to disambiguate when the skill id alone is ambiguous."),
        sourceType: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe('Install source, 1-32 characters, defaulting to "catalog". The API accepts any string here rather than a fixed enum, but only "catalog" (requires the skill to exist in the marketplace catalog) and "git" (requires sourceRef) get special handling. Any value other than "catalog" is refused unless the operator sets THALOVANT_ENABLE_GIT_SKILL_SOURCES, because a non-catalog source can pull unvetted code into the runtime.'),
        sourceRef: z.string().min(1).max(255).optional().describe("Max 255 characters. Required for git installs — a git install without a valid repository URL fails 422. Only usable when THALOVANT_ENABLE_GIT_SKILL_SOURCES is set."),
        versionPin: z.string().min(1).max(64).optional().describe("Pin the skill to an exact version. Max 64 characters."),
        active: z
          .boolean()
          .optional()
          .describe("Whether the skill is enabled after install. Defaults to true. Installing with false also adds the skill to the group's blacklist."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ runtimeGroupId, skillId, marketplaceSkillId, sourceType, sourceRef, versionPin, active, ...auth }) => {
      if (!isCatalogSource(sourceType) && !gitSkillSourcesEnabled()) {
        throw new Error(
          `Refusing to install a skill from non-catalog source "${sourceType}". A non-catalog source (for example sourceType "git" with an arbitrary sourceRef) can pull unvetted code into the runtime and is disabled by default. ` +
            "Set THALOVANT_ENABLE_GIT_SKILL_SOURCES=1 to allow non-catalog skill sources, or install from the marketplace catalog by omitting sourceType (or setting it to \"catalog\").",
        );
      }
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      const options: RuntimeGroupSkillInstallOptions = { marketplaceSkillId, sourceType, sourceRef, versionPin, active };
      return jsonContent(
        redactSecrets(await callControlPlane("skillInstall", () => api.installRuntimeGroupSkill(runtimeGroupId, skillId, options))),
      );
    },
  );

  registerThalovantTool(server,
    "thalovant_uninstall_runtime_group_skill",
    {
      title: "Uninstall Runtime Group Skill",
      description:
        "Remove one skill from a Thalovant runtime group. This removes only the named skill; the runtime group and its other skills are untouched. Requires the hubs:write scope and a paid plan.",
      inputSchema: {
        ...controlPlaneSchema,
        runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
        skillId: z.string().min(1).describe("Skill id to remove."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ runtimeGroupId, skillId, ...auth }) => {
      const api = await createControlPlane(auth);
      ensureAuthenticated(api);
      await callControlPlane("write", () => api.uninstallRuntimeGroupSkill(runtimeGroupId, skillId));
      return textContent("Runtime group skill uninstalled.");
    },
  );

  if (destructiveToolsEnabled()) {
    registerThalovantTool(server,
      "thalovant_delete_hub",
      {
        title: "Delete Hub",
        description:
          "Permanently delete a Thalovant hub along with its dependent clients and ACLs. This cannot be undone. Requires the hub's current etag, read from the `etag` field in the hub resource BODY returned by thalovant_get_hub — the API sends no ETag response header — and sent as If-Match; a missing or stale etag fails 412 and deletes nothing. Requires the hubs:write scope and a paid plan. This tool is disabled unless the operator sets THALOVANT_ENABLE_DESTRUCTIVE_TOOLS.",
        inputSchema: {
          ...controlPlaneSchema,
          hubId: z.string().min(1).describe("Hub UUID. This authenticated route rejects slugs."),
          etag: hubEtagSchema,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ hubId, etag, ...auth }) => {
        const api = await createControlPlane(auth);
        ensureAuthenticated(api);
        await callControlPlane("hubWrite", () => api.deleteHub(hubId, { etag }));
        return textContent("Hub deleted.");
      },
    );

    registerThalovantTool(server,
      "thalovant_delete_runtime_group",
      {
        title: "Delete Runtime Group",
        description:
          "Permanently delete a Thalovant runtime group. This cannot be undone. The API answers HTTP 409 for the workspace default group and for a group that still has hubs attached — move or delete those hubs first. This route takes no etag. Requires the hubs:write scope and a paid plan. This tool is disabled unless the operator sets THALOVANT_ENABLE_DESTRUCTIVE_TOOLS.",
        inputSchema: {
          ...controlPlaneSchema,
          runtimeGroupId: z.string().min(1).describe("Runtime group UUID."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ runtimeGroupId, ...auth }) => {
        const api = await createControlPlane(auth);
        ensureAuthenticated(api);
        await callControlPlane("write", () => api.deleteRuntimeGroup(runtimeGroupId));
        return textContent("Runtime group deleted.");
      },
    );
  }

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
