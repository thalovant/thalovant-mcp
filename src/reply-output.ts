import type { ThalovantReply } from "@thalovant/sdk";
import { createHash } from "node:crypto";

/** Keep embedded skill bytes out of the language model's text context. */
export function runtimeReplyContent(reply: ThalovantReply, includeAudio = false) {
  const clips: Array<{ type: "audio"; data: string; mimeType: string } | {
    type: "resource"; resource: { uri: string; mimeType: string; blob: string };
  }> = [];
  const media: Array<{ eventIndex: number; byteLength?: number; mimeType?: string; error?: string }> = [];
  const events = reply.events.map((event, eventIndex) => {
    const output = event.asObject();
    if (!event.isAudio) return output;
    const { binary_data: _encoded, ...data } = event.data;
    output.data = data;
    try {
      const bytes = Buffer.from(event.audioBytes());
      const mimeType = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE" ? "audio/wav"
        : bytes.subarray(0, 4).toString() === "OggS" ? "audio/ogg"
        : bytes.subarray(0, 4).toString() === "fLaC" ? "audio/flac"
        : bytes.subarray(0, 3).toString() === "ID3" ? "audio/mpeg" : "application/octet-stream";
      media.push({ eventIndex, byteLength: bytes.length, mimeType });
      if (includeAudio) {
        const encoded = bytes.toString("base64");
        clips.push(mimeType.startsWith("audio/") ? { type: "audio", data: encoded, mimeType } : {
          type: "resource", resource: { uri: `thalovant-audio://sha256/${createHash("sha256").update(bytes).digest("hex")}`, mimeType, blob: encoded },
        });
      }
    } catch { media.push({ eventIndex, error: "Missing, invalid or oversized embedded audio." }); }
    return output;
  });
  return { summary: {
    text: reply.text, displayText: reply.displayText, utterances: reply.utterances,
    handled: reply.handled, ok: reply.ok, sessionId: reply.sessionId, requestId: reply.requestId,
    lang: reply.lang, hasAudio: reply.hasAudio ?? false, droppedMedia: reply.droppedMedia ?? 0,
    displayItems: reply.displayItems({ maxTextChars: 1_000 }), events, media,
    failureEvent: reply.failureEvent?.asObject(),
  }, clips };
}
