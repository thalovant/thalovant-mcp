/**
 * Intercom guardrails that belong to this server, not to the model.
 *
 * - A hub allowlist (`THALOVANT_INTERCOM_ALLOWED_HUBS`) for every intercom tool.
 * - A per-principal rate cap on announcements, on top of the API's per-hub one.
 * - A person's confirmation, through MCP elicitation, for urgent announcements
 *   and for allowAll: the model's own `confirmUrgent` / `allowAll` arguments are
 *   only assertions, and an injected instruction can set them.
 *
 * Nothing here ever holds an announcement's text beyond showing it to the
 * person in the confirmation (the MCP client already has it as the tool call).
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import { cleanLabel } from "./intercom-output.js";
import type { IntercomTargets } from "./intercom-output.js";

/** A refusal by one of the guardrails: the audit log records its reason. */
export class IntercomRefusal extends Error {
  readonly reason: "hub_not_allowed" | "rate_limited" | "confirmation_unsupported" | "confirmation_declined" | "confirmation_failed" | "urgent_scope_missing";

  constructor(reason: IntercomRefusal["reason"], message: string) {
    super(message);
    this.name = "IntercomRefusal";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Hub allowlist
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HubAllowlist {
  /** Whether the variable names any entry. When false every hub the token reaches is allowed. */
  configured: boolean;
  /** The valid hub ids, lower case. */
  hubs: string[];
  /** How many entries were not UUIDs (and so allow nothing). */
  invalid: number;
}

/** Read `THALOVANT_INTERCOM_ALLOWED_HUBS`: comma-separated hub UUIDs; unset or empty means any hub. */
export function intercomHubAllowlist(env: NodeJS.ProcessEnv = process.env): HubAllowlist {
  const entries = (env.THALOVANT_INTERCOM_ALLOWED_HUBS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const hubs = [...new Set(entries.filter((entry) => UUID.test(entry)))];
  return { configured: entries.length > 0, hubs, invalid: entries.length - entries.filter((entry) => UUID.test(entry)).length };
}

/**
 * Refuse a hub the operator did not list. With a list that names no valid UUID
 * nothing is allowed: a typo must not open every hub.
 */
export function assertIntercomHubAllowed(hubId: string, env: NodeJS.ProcessEnv = process.env): void {
  const allowlist = intercomHubAllowlist(env);
  if (!allowlist.configured) return;
  if (!allowlist.hubs.includes(hubId.trim().toLowerCase())) {
    throw new IntercomRefusal(
      "hub_not_allowed",
      `Hub ${cleanLabel(hubId) ?? "?"} is not one this server may use for Intercom: the operator limits it with THALOVANT_INTERCOM_ALLOWED_HUBS. Use one of the hubs the person named, or ask the operator.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-principal rate cap
// ---------------------------------------------------------------------------

export interface RateLimits {
  /** Normal announcements per rolling minute. */
  normalPerMinute: number;
  /** Urgent announcements per rolling hour. */
  urgentPerHour: number;
}

export const DEFAULT_NORMAL_PER_MINUTE = 20;
export const DEFAULT_URGENT_PER_HOUR = 5;

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  // A zero or a non-number would silently turn the cap off or block everything:
  // keep the default and let the operator see it in thalovant_config_status.
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 10_000) : fallback;
}

/** `THALOVANT_INTERCOM_RATE_NORMAL_PER_MINUTE` (default 20) and `THALOVANT_INTERCOM_RATE_URGENT_PER_HOUR` (default 5). */
export function intercomRateLimits(env: NodeJS.ProcessEnv = process.env): RateLimits {
  return {
    normalPerMinute: positiveInt(env.THALOVANT_INTERCOM_RATE_NORMAL_PER_MINUTE, DEFAULT_NORMAL_PER_MINUTE),
    urgentPerHour: positiveInt(env.THALOVANT_INTERCOM_RATE_URGENT_PER_HOUR, DEFAULT_URGENT_PER_HOUR),
  };
}

const MINUTE_MS = 60_000;
const SWEEP_ABOVE = 256;
const HOUR_MS = 3_600_000;

/** A sliding window per principal: announcements this server sent, by priority. */
export class IntercomRateCap {
  private readonly normal = new Map<string, number[]>();
  private readonly urgent = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private window(priority: "normal" | "urgent"): { rows: Map<string, number[]>; span: number } {
    return priority === "urgent" ? { rows: this.urgent, span: HOUR_MS } : { rows: this.normal, span: MINUTE_MS };
  }

  private recent(principal: string, priority: "normal" | "urgent"): number[] {
    const { rows, span } = this.window(priority);
    const cutoff = this.now() - span;
    const kept = (rows.get(principal) ?? []).filter((at) => at > cutoff);
    if (kept.length) rows.set(principal, kept);
    else rows.delete(principal);
    return kept;
  }

  /** Seconds to wait before another announcement of this priority may go, or 0 when one may go now. */
  retryAfterSeconds(principal: string, priority: "normal" | "urgent", limits: RateLimits): number {
    const limit = priority === "urgent" ? limits.urgentPerHour : limits.normalPerMinute;
    const kept = this.recent(principal, priority);
    if (kept.length < limit) return 0;
    const { span } = this.window(priority);
    const blocking = kept[kept.length - limit] ?? this.now();
    return Math.max(1, Math.ceil((blocking + span - this.now()) / 1000));
  }

  /** Count one announcement now. Throws an IntercomRefusal when the cap is already reached. */
  consume(principal: string, priority: "normal" | "urgent", limits: RateLimits): void {
    this.refuseIfReached(principal, priority, limits);
    const { rows } = this.window(priority);
    rows.set(principal, [...this.recent(principal, priority), this.now()]);
    // A principal that never comes back would keep its row: sweep the expired ones when many have accumulated.
    if (rows.size > SWEEP_ABOVE) for (const other of [...rows.keys()]) this.recent(other, priority);
  }

  /** Throw an IntercomRefusal when the cap is reached, without counting anything. */
  refuseIfReached(principal: string, priority: "normal" | "urgent", limits: RateLimits): void {
    const wait = this.retryAfterSeconds(principal, priority, limits);
    if (wait > 0) {
      const what = priority === "urgent" ? `${limits.urgentPerHour} urgent announcement(s) an hour` : `${limits.normalPerMinute} normal announcement(s) a minute`;
      throw new IntercomRefusal(
        "rate_limited",
        `This server's own cap for one caller (${what}) is reached, so nothing was sent. Try again in about ${wait} s. The operator can change it with THALOVANT_INTERCOM_RATE_NORMAL_PER_MINUTE and THALOVANT_INTERCOM_RATE_URGENT_PER_HOUR; the API has its own per-hub limits besides.`,
      );
    }
  }
}

/** The one cap of this process. */
export const intercomRateCap = new IntercomRateCap();

// ---------------------------------------------------------------------------
// Confirmation by a person (MCP elicitation)
// ---------------------------------------------------------------------------

const MAX_NAMES_SHOWN = 10;

/** The targets in a few words for a person: who would hear it. Names are household-supplied, so they are cleaned. */
export function describeTargets(targets: IntercomTargets): string {
  if ("all" in targets) return "EVERY speaker of the hub that is set to receive announcements";
  const kind = "speakers" in targets ? "speaker" : "rooms" in targets ? "room" : "group";
  const names = ("speakers" in targets ? targets.speakers : "rooms" in targets ? targets.rooms : targets.groups).map((name) => cleanLabel(name) ?? "?");
  const shown = names.slice(0, MAX_NAMES_SHOWN).join(", ");
  const more = names.length > MAX_NAMES_SHOWN ? ` and ${names.length - MAX_NAMES_SHOWN} more` : "";
  return `${names.length} ${kind}${names.length === 1 ? "" : "s"}: ${shown}${more}`;
}

export interface ConfirmationRequest {
  hubId: string;
  text: string;
  targets: IntercomTargets;
  priority: "normal" | "urgent";
  repeat?: { times: number; interval_seconds: number };
  /** Why the person is asked: urgent, allowAll or both. */
  reasons: string[];
}

/** The question the person answers: hub, who hears it, how, what. */
export function confirmationMessage(request: ConfirmationRequest): string {
  const lines = [
    `Say this ALOUD in a home? ${request.reasons.join(" and ")} needs your confirmation.`,
    "",
    `Hub: ${request.hubId}`,
    `Priority: ${request.priority.toUpperCase()}${
      request.priority === "urgent"
        ? request.repeat
          ? ` (said ${request.repeat.times} time(s), ${request.repeat.interval_seconds} s apart, until someone says they heard it; ignores do-not-disturb)`
          : " (ignores do-not-disturb)"
        : ""
    }`,
    `Targets: ${describeTargets(request.targets)}`,
    `Text: "${request.text}"`,
    "",
    "Intercom is not a certified safety system. The text is not stored by Thalovant or this server.",
  ];
  return lines.join("\n");
}

type ElicitationCapability = { form?: object; url?: object } | undefined;

/**
 * Whether the connected client can show a form. The spec reads an empty
 * `elicitation: {}` as form support; only a client that declared URL mode alone,
 * or none, cannot.
 */
export function supportsFormElicitation(capability: ElicitationCapability): boolean {
  if (!capability) return false;
  const form = capability.form !== undefined;
  const url = capability.url !== undefined;
  return form || !url;
}

export interface ConfirmationCall {
  /**
   * Set when this server's own transport cannot carry a question to the person
   * (Streamable HTTP in JSON-response mode), so asking would only hang: the
   * announcement is refused at once, saying why.
   */
  cannotAsk?: string;
  /** The tool call's cancellation signal. */
  signal?: AbortSignal;
  /** The tool call's request id, so a Streamable HTTP server asks on the call's own stream. */
  requestId?: RequestId;
}

/** A person may take a while to read and answer. */
const CONFIRMATION_TIMEOUT_MS = 5 * 60_000;

const SCHEMA = {
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      title: "Say it aloud now",
      description: "Tick to send this announcement. Leave it unticked, or decline, to send nothing.",
      default: false,
    },
  },
  required: ["confirm"],
};

/**
 * Ask the person to confirm, with MCP elicitation, or refuse. Returns only when
 * they accepted with `confirm: true`. A client without elicitation, one that
 * errors or times out, a decline and a cancel all refuse: the model's own
 * arguments are never enough for these announcements.
 */
export async function requireConfirmation(server: Server, request: ConfirmationRequest, call: ConfirmationCall = {}): Promise<void> {
  if (call.cannotAsk) {
    throw new IntercomRefusal(
      "confirmation_unsupported",
      `${call.cannotAsk}, so ${request.reasons.join(" and ")} is refused and nothing was sent. A normal announcement to named speakers, rooms or groups needs no confirmation.`,
    );
  }
  const capability = server.getClientCapabilities()?.elicitation as ElicitationCapability;
  if (!supportsFormElicitation(capability)) {
    throw new IntercomRefusal(
      "confirmation_unsupported",
      `This MCP client cannot ask the person to confirm (it does not support elicitation), so ${request.reasons.join(" and ")} is refused and nothing was sent. A normal announcement to named speakers, rooms or groups needs no confirmation; for this one, ask the person to use the Thalovant console.`,
    );
  }
  const params = { mode: "form" as const, message: confirmationMessage(request), requestedSchema: SCHEMA };
  const options = { signal: call.signal, relatedRequestId: call.requestId, timeout: CONFIRMATION_TIMEOUT_MS };
  let result: { action: string; content?: Record<string, unknown> };
  try {
    // elicitInput insists on a declared `form` member; a client that sent the
    // legacy empty `elicitation: {}` gets the same request without that check.
    result = capability?.form !== undefined
      ? await server.elicitInput(params, options)
      : await server.request({ method: "elicitation/create", params }, ElicitResultSchema, options);
  } catch {
    throw new IntercomRefusal(
      "confirmation_failed",
      "The confirmation did not complete (the client failed, timed out, or answered in a form this server cannot accept), so nothing was sent.",
    );
  }
  if (result.action !== "accept" || result.content?.confirm !== true) {
    throw new IntercomRefusal("confirmation_declined", "The person did not confirm, so nothing was sent. Do not ask again unless they ask for it.");
  }
}
