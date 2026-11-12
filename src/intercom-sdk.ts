/**
 * DEPENDENCY NOTE (Intercom, contract v1, section B): a local adapter.
 *
 * The Node SDK is gaining `announce`, `getAnnouncement`, `cancelAnnouncement`,
 * `listAnnouncements`, `listIntercomSpeakers`, `updateIntercomSpeaker`,
 * `getIntercomSettings` and `setIntercomSettings` on `ThalovantControlPlane`
 * (branch feature/intercom-v1 of thalovant-node-sdk). Until a release carrying
 * them is published and this package depends on it, the four calls the tools
 * need go through the functions below, which speak the same HTTP routes
 * directly. When the SDK ships, replace the bodies with the SDK methods (keep
 * these four signatures and `src/intercom-output.ts` unchanged) and delete the
 * fetch code. Nothing else in this package depends on how the routes are
 * reached.
 *
 * Rules kept from the SDK's own transport: the bearer token goes only to the
 * API's origin, over HTTPS (or explicit loopback HTTP), redirects are never
 * followed, and a request that got no answer is a ThalovantApiUnreachableError.
 * There is NO retry here: an announcement that got no answer may have been
 * spoken.
 */
import { ThalovantApiError, ThalovantApiUnreachableError } from "@thalovant/sdk";
import type { ThalovantControlPlane } from "@thalovant/sdk";

/** The body of POST /v1/hubs/{hub_id}/intercom/announce, as the API reads it. */
export interface IntercomAnnounceBody {
  text: string;
  targets: { all: true } | { speakers: string[] } | { rooms: string[] } | { groups: string[] };
  priority: "normal" | "urgent";
  repeat?: { times: number; interval_seconds: number };
  lang?: string;
}

const READ_TIMEOUT_MS = 15_000;
/** A normal announcement waits up to 10 s for the hub, so allow a margin. */
const ANNOUNCE_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

async function intercomRequest(
  api: ThalovantControlPlane,
  method: "GET" | "POST",
  path: string,
  options: { body?: Json; headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<Json> {
  return (await intercomRequestWithHeaders(api, method, path, options)).body;
}

/** {@link intercomRequest}, and the response's headers beside the body (for `Idempotency-Replayed`). */
async function intercomRequestWithHeaders(
  api: ThalovantControlPlane,
  method: "GET" | "POST",
  path: string,
  options: { body?: Json; headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<{ body: Json; headers: Pick<Headers, "get"> }> {
  if (!api.accessToken) throw new ThalovantApiError("Missing Thalovant API access token.");
  let base: URL;
  let url: URL;
  try {
    base = new URL(api.apiUrl);
    url = new URL(path.replace(/^\/+/, ""), base);
  } catch {
    throw new ThalovantApiError("The configured control-plane API URL is invalid.");
  }
  if (url.origin !== base.origin || url.username || url.password) {
    throw new ThalovantApiError("Refusing a request off the Thalovant API's origin.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ThalovantApiError("Credential-bearing control-plane requests require HTTPS (except explicit loopback HTTP).");
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${api.accessToken}`,
    "user-agent": "thalovant-mcp-intercom",
    ...(options.headers ?? {}),
  };
  if (options.body) headers["content-type"] = "application/json";
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: "error",
      signal,
    });
    // The headers can arrive and the body stall or break: reading it is inside
    // the same boundary as the request, because the API may already have acted.
    text = await response.text();
  } catch {
    if (options.signal?.aborted) throw new ThalovantApiError("The request was cancelled.");
    // No cause is kept: it can carry URLs. A timeout, or a body that did not
    // arrive, is unreachable too: the API may still have acted.
    throw new ThalovantApiUnreachableError("Could not reach the Thalovant API, did not get its whole answer, or the endpoint redirected the request.");
  }
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    parsed = undefined;
  }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : undefined;
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ThalovantApiError(`Thalovant API returned HTTP ${response.status}.`, {
      statusCode: response.status,
      problem: record,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 && response.headers.has("retry-after") ? retryAfter : undefined,
    });
  }
  if (!record) {
    // A success whose body is not a JSON object. After a POST the API may well
    // have acted, so the caller cannot know what happened: that is an uncertain
    // outcome, like an answer that did not arrive, not a refusal. A read has
    // changed nothing and is safe to repeat.
    if (method === "POST") {
      throw new ThalovantApiUnreachableError("The Thalovant API answered with a success whose body is not a JSON object, so what happened is not known.");
    }
    throw new ThalovantApiError("Thalovant API returned an unexpected response shape.", { statusCode: response.status });
  }
  return { body: record, headers: response.headers };
}

/**
 * One path segment: percent-encoded, and never empty, `.` or `..`. A dot
 * segment survives encoding and a URL parser resolves it, which would move the
 * request off the route the tool means (`/v1/hubs/../intercom/announce`).
 */
function segment(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "..") {
    throw new ThalovantApiError(`The ${what} is not a valid id.`);
  }
  return encodeURIComponent(trimmed);
}

const hubPath = (hubId: string): string => `/v1/hubs/${segment(hubId, "hub id")}/intercom`;

/** GET /v1/hubs/{hubId}/intercom/speakers (scope intercom:read). */
export async function listIntercomSpeakers(api: ThalovantControlPlane, hubId: string, signal?: AbortSignal): Promise<Json> {
  return intercomRequest(api, "GET", `${hubPath(hubId)}/speakers`, { timeoutMs: READ_TIMEOUT_MS, signal });
}

/** Whether an answer carries what an announcement always has: a non-empty `id` and `status` (strings). */
function hasAnnouncementIdentity(body: Json): boolean {
  return typeof body.id === "string" && body.id !== "" && typeof body.status === "string" && body.status !== "";
}

/**
 * GET /v1/hubs/{hubId}/intercom/announcements/{id} (scope intercom:read).
 *
 * A 2xx answer without the announcement's `id` and `status` is refused as an
 * invalid response (reading changes nothing, so it is safe to try again):
 * formatting it would report a null id and an unknown status as if they were a
 * result a caller could act on.
 */
export async function getAnnouncement(api: ThalovantControlPlane, hubId: string, announcementId: string, signal?: AbortSignal): Promise<Json> {
  const body = await intercomRequest(api, "GET", `${hubPath(hubId)}/announcements/${segment(announcementId, "announcement id")}`, { timeoutMs: READ_TIMEOUT_MS, signal });
  if (!hasAnnouncementIdentity(body)) {
    throw new ThalovantApiError("The Thalovant API answered the announcement read without its id and status, so this is not a usable announcement. Reading is safe to try again.");
  }
  return body;
}

/**
 * POST /v1/hubs/{hubId}/intercom/announcements/{id}/cancel (scope intercom:send).
 *
 * Stops an announcement that is still `sending`: the API tells the hub, which
 * stops repeating at once, and answers the announcement with status
 * `cancelled` and `hub_confirmed` (false when the hub could not confirm: the
 * record is cancelled either way). Any other status is a 409 `not_cancellable`.
 * Cancelling only ever stops speech, and is safe to repeat. No body, no retry
 * here: the caller reads the announcement to see where it stands. A 2xx answer
 * without the announcement's `id` and `status` is reported as an unreachable
 * API (it is not known whether the stop took), so the cancel hint says to read
 * it and cancel again.
 */
export async function cancelAnnouncement(api: ThalovantControlPlane, hubId: string, announcementId: string, signal?: AbortSignal): Promise<Json> {
  const body = await intercomRequest(api, "POST", `${hubPath(hubId)}/announcements/${segment(announcementId, "announcement id")}/cancel`, { timeoutMs: READ_TIMEOUT_MS, signal });
  if (!hasAnnouncementIdentity(body)) {
    throw new ThalovantApiUnreachableError("The Thalovant API answered the cancel without the announcement's id and status.");
  }
  return body;
}

/**
 * POST /v1/hubs/{hubId}/intercom/announce (scope intercom:send, and
 * intercom:urgent as well for an urgent one), once, with an Idempotency-Key.
 * `replayed` says the answer is the stored announcement for that key
 * (`Idempotency-Replayed: true`): nothing new was sent.
 *
 * A 2xx answer must carry the announcement's `id` and `status` (200 completed,
 * partial or failed; 202 sending): without them the caller could neither read
 * the announcement back nor say what happened, yet it may have been spoken. That
 * is reported as an unreachable API, so the announce handler gives the
 * "do not resend, reuse the key" guidance. A 2xx whose body is not a JSON
 * object at all (malformed JSON, an array) is classified the same way.
 */
export async function announce(
  api: ThalovantControlPlane,
  hubId: string,
  body: IntercomAnnounceBody,
  options: { idempotencyKey: string; signal?: AbortSignal },
): Promise<{ result: Json; replayed: boolean }> {
  const { body: result, headers } = await intercomRequestWithHeaders(api, "POST", `${hubPath(hubId)}/announce`, {
    body: body as unknown as Json,
    headers: { "Idempotency-Key": options.idempotencyKey },
    timeoutMs: ANNOUNCE_TIMEOUT_MS,
    signal: options.signal,
  });
  if (!hasAnnouncementIdentity(result)) {
    throw new ThalovantApiUnreachableError("The Thalovant API answered the announcement without its id and status.");
  }
  // `Idempotency-Replayed: true`: the stored announcement for this key; nothing new was sent.
  const replayed = (headers.get("Idempotency-Replayed") ?? "").trim().toLowerCase() === "true";
  return { result, replayed };
}
