import { ThalovantApiError } from "@thalovant/sdk";

/**
 * Problem+JSON members every refusal carries that say nothing the lines above
 * them do not: the status is on the first line, and `type`/`title`/`instance`
 * are the handler's own bookkeeping.
 */
const ENVELOPE = new Set(["type", "title", "status", "instance"]);

/** A detail or a field list longer than this is cut, and says so. */
const MAX_SECTION_CHARS = 4_000;

function bounded(text: string): string {
  if (text.length <= MAX_SECTION_CHARS) return text;
  return `${text.slice(0, MAX_SECTION_CHARS)}… (${text.length - MAX_SECTION_CHARS} more characters)`;
}

/**
 * What a model reads when a control-plane call fails: the SDK's one-line
 * message, then what the API actually said beside it.
 *
 * The message is bounded at 160 characters, and a structured refusal is
 * usually longer than that -- a `platform_image_required` 403 names every
 * image each refused key may be instead, and that list was the part cut off.
 * So the code, the whole sentence (when the message line had to shorten it)
 * and every other field of the body follow, as one compact JSON object.
 * `redact` is the server's own secret redaction, applied to the fields: a
 * validation error echoes back what it was sent.
 *
 * Returns undefined for anything that is not a `ThalovantApiError`.
 */
export function apiErrorText(error: unknown, redact: (value: unknown) => unknown): string | undefined {
  if (!(error instanceof ThalovantApiError)) return undefined;
  const lines = [error.message];
  if (error.code) lines.push(`code: ${error.code}`);
  const shown = error.message.replace(/\s+/g, " ");
  if (error.detail && !shown.includes(error.detail.replace(/\s+/g, " ").trim())) {
    lines.push(`detail: ${bounded(error.detail)}`);
  }
  const problem = error.problem;
  if (problem) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(problem)) {
      if (ENVELOPE.has(key)) continue;
      // Already on a line above when they were read as strings.
      if ((key === "code" || key === "detail") && typeof value === "string") continue;
      fields[key] = value;
    }
    if (Object.keys(fields).length) lines.push(`fields: ${bounded(JSON.stringify(redact(fields)))}`);
  }
  return lines.join("\n");
}
