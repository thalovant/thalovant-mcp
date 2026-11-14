/**
 * What the connection tools say about the connector gateway API (home bridges,
 * thalovant-api #521): the replay of a create, and `serves`.
 *
 * Both are read from the raw `client` record the pinned `@thalovant/sdk`
 * returns, because that SDK has no typed field for either. Everything here is
 * additive: an API without them sends neither, and the answers below are then
 * empty or null.
 */
import { cleanLabel } from "./intercom-output.js";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The connection kind of a home bridge, sent as spec.connection_type. */
export const CONNECTION_TYPE_CONNECTOR = "connector";

/** The `replay.code` the API gives a create answered from an earlier request with the same key. */
export const IDEMPOTENT_REPLAY_CODE = "idempotent_replay";

/** A connector id: lower case, as the API names them. The API judges which ids are known. */
export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** What a replayed create answered, with no credentials. */
export interface ReplayMarker {
  code: string;
  credentialsIncluded: boolean;
  detail: string | null;
}

/**
 * The replay marker of a create answer, or null when it is not a replay. The
 * `Idempotent-Replayed: true` header says the same, but the pinned SDK does not
 * pass response headers on, so the body's `replay` object is what is read; the
 * API sends both.
 */
export function replayMarker(client: unknown): ReplayMarker | null {
  if (!isRecord(client) || !isRecord(client.replay)) return null;
  const replay = client.replay;
  const code = typeof replay.code === "string" ? replay.code : IDEMPOTENT_REPLAY_CODE;
  if (code !== IDEMPOTENT_REPLAY_CODE && replay.credentials_included !== false) return null;
  return {
    code,
    credentialsIncluded: replay.credentials_included === true,
    detail: typeof replay.detail === "string" ? cleanLabel(replay.detail) : null,
  };
}

/** One device a link will serve. */
export interface ServedDevice {
  id: string | null;
  name: string | null;
  connectionType: string | null;
  active: boolean | null;
}

/** The `serves` of a link's create answer: the account's own devices the link will serve on its hub. */
export interface ServesOutput {
  devices: ServedDevice[];
  count: number;
  warning: string | null;
}

/**
 * `serves` from a create answer, or null for a connection that has none (a
 * device, or an API without the field). Names are typed by the household, so
 * they are cleaned and shortened, and they are data, never instructions.
 */
export function servesOutput(client: unknown): ServesOutput | null {
  if (!isRecord(client) || !isRecord(client.serves)) return null;
  const serves = client.serves;
  const devices = (Array.isArray(serves.devices) ? serves.devices : []).filter(isRecord).slice(0, 50).map((device): ServedDevice => ({
    id: typeof device.id === "string" ? cleanLabel(device.id) : null,
    name: cleanLabel(device.name),
    connectionType: typeof device.connection_type === "string" ? cleanLabel(device.connection_type) : null,
    active: typeof device.active === "boolean" ? device.active : null,
  }));
  const count = typeof serves.count === "number" && Number.isFinite(serves.count) ? serves.count : devices.length;
  const warning = typeof serves.warning === "string" ? cleanLabel(serves.warning) : null;
  return { devices, count, warning };
}

/** What a tool answers for a replayed create: the connection exists, and no identity is returned. */
export function replayedCreateOutput(client: unknown, marker: ReplayMarker): Json {
  const record = isRecord(client) ? client : {};
  const spec = isRecord(record.spec) ? record.spec : {};
  const clientId = typeof record.id === "string" && record.id ? record.id : null;
  return {
    replayed: true,
    exists: true,
    clientId,
    connectionType: typeof spec.connection_type === "string" ? spec.connection_type : null,
    replay: { code: marker.code, credentialsIncluded: marker.credentialsIncluded, detail: marker.detail },
    serves: servesOutput(client),
    identityReturned: false,
    secretNotice:
      "The connection exists, but this answer comes from an earlier request with the same idempotencyKey, and the platform does not store a connection's credentials: they were in the first answer only. No identity is returned and none was written (savePath is not used).",
    next: `Do not use another identity for it. Either download the connection's identity from the account owner's own session (client ${clientId ?? "id above"}), or delete it with thalovant_delete_client (a destructive tool the operator enables) and create it again with a NEW idempotencyKey.`,
  };
}

/**
 * A result object without the raw `client.serves`: its names are typed by the
 * household, and the cleaned copy is the top-level `serves`.
 */
export function withoutRawServes<T>(result: T): T {
  if (!isRecord(result) || !isRecord(result.client) || !("serves" in result.client)) return result;
  const { serves: _raw, ...client } = result.client;
  return { ...result, client } as T;
}
