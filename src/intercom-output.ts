/**
 * Intercom tools: input checks and output whitelists.
 *
 * An announcement's text is spoken aloud in a home and is never stored by the
 * platform, so this server does not keep it either: only its length and
 * SHA-256 reach the audit log, no error repeats it, and the output of a tool
 * carries only the whitelisted members below (the API sends no text back, but
 * a future member must not slip through unreviewed).
 */
import { createHash } from "node:crypto";

/** Longest announcement, in characters (contract v1). */
export const INTERCOM_MAX_TEXT = 280;
/** Most speakers one announcement may name. */
export const INTERCOM_MAX_SPEAKERS = 50;

/** Shown in the tool description and in every announce answer. */
export const INTERCOM_NOTICE =
  "Intercom is not a certified safety system: it does not replace smoke or CO alarms, medical alert devices or emergency services.";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Control characters, line and paragraph separators, bidirectional overrides
 * and isolates: none belongs in a sentence a speaker reads out. Markup
 * brackets are refused too, because a speech engine may read them as SSML.
 */
const FORBIDDEN_TEXT = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069<>]/u;

/**
 * Check an announcement's text. Returns the trimmed text or throws an error
 * that never repeats it.
 */
export function checkAnnouncementText(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error("The announcement text is empty.");
  if ([...text].length > INTERCOM_MAX_TEXT) {
    throw new Error(`The announcement text is longer than ${INTERCOM_MAX_TEXT} characters.`);
  }
  if (FORBIDDEN_TEXT.test(text)) {
    throw new Error("The announcement text must be plain text: no control characters, line breaks, text-direction marks or < > markup.");
  }
  return text;
}

/** What the audit log records of an announcement instead of its text. */
export function announcementDigest(text: string): { textLen: number; textSha256: string } {
  return { textLen: [...text].length, textSha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

export type IntercomTargets = { all: true } | { speakers: string[] } | { rooms: string[] } | { groups: string[] };

/**
 * Exactly one explicit target kind. `all` needs allowAll: true; naming
 * nothing is refused rather than read as everyone.
 */
export function resolveTargets(input: {
  speakers?: string[];
  rooms?: string[];
  groups?: string[];
  allowAll?: boolean;
}): IntercomTargets {
  const kinds = (["speakers", "rooms", "groups"] as const).filter((key) => (input[key]?.length ?? 0) > 0);
  const count = kinds.length + (input.allowAll ? 1 : 0);
  if (count === 0) {
    throw new Error("Name who should hear it: speakers (client ids or slugs), rooms or groups. To speak on every speaker of the hub, set allowAll to true; nothing is sent to everyone by default.");
  }
  if (count > 1) {
    throw new Error("Use one kind of target per announcement: speakers, rooms, groups, or allowAll.");
  }
  if (input.allowAll) return { all: true };
  const kind = kinds[0];
  if (!kind) throw new Error("Name who should hear it.");
  return { [kind]: input[kind] ?? [] } as IntercomTargets;
}

/** The targets as the audit log records them: counts and names, never text. */
export function auditTargets(targets: IntercomTargets): Json {
  if ("all" in targets) return { all: true };
  if ("speakers" in targets) return { speakers: targets.speakers };
  if ("rooms" in targets) return { rooms: targets.rooms };
  return { groups: targets.groups };
}

function dnd(value: unknown): Json {
  const source = isRecord(value) ? value : {};
  const hours = isRecord(source.quiet_hours) ? source.quiet_hours : {};
  return {
    enabled: source.enabled === true,
    quiet_hours: { start: str(hours.start), end: str(hours.end), timezone: str(hours.timezone) },
  };
}

function speaker(value: unknown): Json {
  const row = isRecord(value) ? value : {};
  const policy = isRecord(row.intercom) ? row.intercom : {};
  return {
    client_id: str(row.client_id),
    slug: str(row.slug),
    name: str(row.name),
    online: row.online === true,
    last_seen_at: str(row.last_seen_at),
    intercom: {
      receive: policy.receive === true,
      room: str(policy.room),
      groups: Array.isArray(policy.groups) ? policy.groups.filter((g): g is string => typeof g === "string") : [],
      dnd: dnd(policy.dnd),
    },
  };
}

/** The speakers of a hub: who may be spoken to, where, and whether they are online. */
export function speakersOutput(body: Json, redact: (value: unknown) => unknown): unknown {
  const items = Array.isArray(body.items) ? body.items.map(speaker) : [];
  const listening = items.filter((item) => (item.intercom as Json).receive === true).length;
  return redact({
    items,
    summary: `${items.length} speaker(s), ${listening} set to receive announcements. A speaker with receive false is never spoken to.`,
  });
}

const DELIVERY_WORDS: Record<string, string> = {
  delivered: "delivered",
  acked: "acknowledged",
  offline: "offline",
  skipped_dnd: "skipped (do not disturb)",
  skipped_not_receiving: "skipped (not set to receive)",
  failed: "failed",
};

function delivery(value: unknown): Json {
  const row = isRecord(value) ? value : {};
  return { client_id: str(row.client_id), slug: str(row.slug), name: str(row.name), status: str(row.status), at: str(row.at) };
}

/** An announcement: its status, each speaker's result in words, and who acknowledged. Never any text. */
export function announcementOutput(body: Json, redact: (value: unknown) => unknown): unknown {
  const deliveries = Array.isArray(body.deliveries) ? body.deliveries.map(delivery) : [];
  const counts = new Map<string, number>();
  for (const row of deliveries) {
    const word = DELIVERY_WORDS[String(row.status)] ?? String(row.status);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const parts = [...counts].map(([word, n]) => `${n} ${word}`);
  const status = str(body.status);
  const waiting = status === "sending" ? " Still being spoken: read it again with thalovant_intercom_get_announcement to follow it." : "";
  return redact({
    id: str(body.id),
    status,
    priority: str(body.priority),
    created_at: str(body.created_at),
    deliveries,
    acked_by: str(body.acked_by),
    summary: `${status ?? "unknown"}: ${parts.length ? parts.join(", ") : "no speakers"}.${waiting}`,
  });
}
