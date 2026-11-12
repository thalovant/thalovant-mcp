/**
 * Message types this server never sends to a hub, whatever the tool.
 *
 * `thalovant.intercom.*` is the hub's Intercom protocol (announce, cancel,
 * policy.set, speakers) and `speak` / `ovos.utterance.speak` make a speaker
 * talk. Both are how an announcement reaches a home, so the only way to cause
 * one from this server is `thalovant_intercom_announce`: opt-in, text and
 * target checks, a person's confirmation for urgent and allowAll, a hub
 * allowlist, a rate cap and an audit record. A runtime identity that is allowed
 * every event type (`allowedTypes: ["*"]`) must not turn the generic tools
 * into a way around those.
 *
 * Two layers, so one does not depend on the other:
 *
 * 1. `thalovant_emit_event` is the one tool that takes a message type from the
 *    caller; it refuses before it connects (`assertBusTypeAllowed`).
 * 2. Every client this server creates for a runtime tool (`thalovant_emit_event`,
 *    `thalovant_ask`, `thalovant_query`, `thalovant_send_action`,
 *    `thalovant_send_code`) has its transport guarded (`guardRuntimeClient`):
 *    each frame that leaves it, bus or hive, query or broadcast, is checked by
 *    type. `ask`, `query` and `send_action` name no type themselves (the SDK
 *    sends `recognizer_loop:utterance`), so this is what keeps them from ever
 *    carrying one, now or after an SDK upgrade. If the guard cannot be
 *    installed the call fails: it never runs unguarded.
 */

/** Bus message types that begin the hub's Intercom protocol. */
export const INTERCOM_BUS_PREFIX = "thalovant.intercom.";
/** Bus message types that make a speaker talk. */
export const SPEAK_BUS_TYPES: readonly string[] = ["speak", "ovos.utterance.speak"];

/** What every refusal says, so a model knows the way forward. */
const WAY_FORWARD =
  "These types make speakers in a home talk, so this server sends them only through thalovant_intercom_announce (opt-in, with confirmation for urgent and allowAll, target checks, a rate cap and an audit record).";

function normalize(type: string): string {
  return type.normalize("NFKC").trim().toLowerCase();
}

function shown(type: string): string {
  const flat = type.replace(/[^\x20-\x7E]/g, "?");
  return flat.length > 64 ? `${flat.slice(0, 63)}…` : flat;
}

/** Why a bus message type is refused, or undefined when it may be sent. A non-string is never refused here. */
export function refusedBusType(type: unknown): string | undefined {
  if (typeof type !== "string") return undefined;
  const name = normalize(type);
  if (name === "thalovant.intercom" || name.startsWith(INTERCOM_BUS_PREFIX)) {
    return `Message type "${shown(type)}" belongs to the hub's Intercom protocol (thalovant.intercom.*) and is never sent by this tool. ${WAY_FORWARD}`;
  }
  if (SPEAK_BUS_TYPES.includes(name)) {
    return `Message type "${shown(type)}" makes a speaker talk and is never sent by this tool. ${WAY_FORWARD}`;
  }
  return undefined;
}

/** Throw when a bus message type is one this server never sends. */
export function assertBusTypeAllowed(type: unknown): void {
  const reason = refusedBusType(type);
  if (reason) throw new Error(reason);
}

const MAX_FRAME_DEPTH = 8;

/**
 * The bus message types a HiveMind frame carries: a `bus` frame's own type,
 * and the type of the bus message inside a `query`, `broadcast`, `propagate`
 * or `escalate` frame (`payload.payload.type`). Only `payload` is followed,
 * never `data`: a sentence or a value inside a message is not a type.
 */
export function busTypesOfFrame(frame: unknown): string[] {
  const types: string[] = [];
  let level: unknown = frame;
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
    if (typeof level !== "object" || level === null) break;
    const payload = (level as { payload?: unknown }).payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) break;
    const type = (payload as { type?: unknown }).type;
    if (typeof type === "string") types.push(type);
    level = payload;
  }
  return types;
}

type Sender = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Check every frame a client's transport sends, by type, and refuse the ones
 * above. Returns the client. Throws, so the caller never uses an unguarded
 * client, when the transport is not the shape this expects (an SDK upgrade
 * that renames it must fail tests and calls rather than silently lose this).
 */
export function guardRuntimeClient<T extends object>(client: T): T {
  const transport = (client as { transport?: unknown }).transport;
  if (typeof transport !== "object" || transport === null) {
    throw new Error("The runtime transport could not be guarded, so nothing was sent.");
  }
  const target = transport as Record<string, unknown>;
  let guarded = 0;
  const wrap = (name: string, typesOf: (args: unknown[]) => string[]): void => {
    const original = target[name];
    if (typeof original !== "function") return;
    // The SDK's senders are async: a refusal is a rejected promise, like any other failed send.
    target[name] = function guardedSend(this: unknown, ...args: unknown[]): unknown {
      try {
        for (const type of typesOf(args)) assertBusTypeAllowed(type);
      } catch (error) {
        return Promise.reject(error);
      }
      return (original as Sender).apply(this ?? transport, args);
    };
    guarded += 1;
  };
  wrap("emitBus", (args) => [String(args[0] ?? "")]);
  wrap("sendHiveMessage", (args) => busTypesOfFrame(args[0]));
  if (guarded === 0) throw new Error("The runtime transport could not be guarded, so nothing was sent.");
  return client;
}
