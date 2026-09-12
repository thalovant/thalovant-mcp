import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { ThalovantEvent, type ThalovantReply } from "@thalovant/sdk";
import { runtimeReplyContent } from "../src/reply-output.js";

function reply(events: ThalovantEvent[]): ThalovantReply {
  return { text: "hello", displayText: "hello", utterances: ["hello"], handled: true, ok: true, events,
    lang: "fr", hasAudio: true, droppedMedia: 2, displayItems: () => [] };
}
describe("embedded audio reply output", () => {
  it("sanitizes a failure reference without duplicating admitted audio", () => {
    const event = new ThalovantEvent("mycroft.audio.queue", { binary_data: "01ff", reason: "fixture" });
    const input = { ...reply([event]), failureEvent: event };
    const output = runtimeReplyContent(input, true);
    expect(JSON.stringify(output.summary)).not.toContain("binary_data");
    expect(output.summary.failureEvent?.data).toEqual({ reason: "fixture" });
    expect(output.clips).toHaveLength(1);
    expect(output.summary.media).toHaveLength(1);
    expect(event.data.binary_data).toBe("01ff");
    const unadmitted = runtimeReplyContent({ ...reply([]), failureEvent: event }, true);
    expect(unadmitted.clips).toEqual([]);
    expect(JSON.stringify(unadmitted.summary)).not.toContain("binary_data");
  });
  it("keeps hex out of text while retaining ordered metadata and explicit audio content", () => {
    const bytes = Buffer.from("RIFF1234WAVEtest");
    const encoded = bytes.toString("hex");
    const input = reply([new ThalovantEvent("mycroft.audio.queue", { binary_data: encoded }), new ThalovantEvent("speak", { utterance: "hello" })]);
    const output = runtimeReplyContent(input);
    expect(JSON.stringify(output.summary)).not.toContain(encoded);
    expect(output.clips).toEqual([]);
    expect(output.summary).toMatchObject({ lang: "fr", hasAudio: true, droppedMedia: 2, media: [{ eventIndex: 0, byteLength: bytes.length, mimeType: "audio/wav" }] });
    expect(runtimeReplyContent(input, true).clips).toEqual([{ type: "audio", data: bytes.toString("base64"), mimeType: "audio/wav" }]);
  });
  it("preserves untyped clips as embedded resources and handles malformed clips locally", () => {
    const input = reply([new ThalovantEvent("mycroft.audio.queue", { binary_data: "01ff" }), new ThalovantEvent("mycroft.audio.queue", { binary_data: "invalid" })]);
    const output = runtimeReplyContent(input, true);
    expect(output.clips).toEqual([{ type: "resource", resource: { uri: `thalovant-audio://sha256/${createHash("sha256").update(Buffer.from([1,255])).digest("hex")}`, mimeType: "application/octet-stream", blob: Buffer.from([1,255]).toString("base64") } }]);
    expect(output.summary.media[1].error).toBeDefined();
    expect(JSON.stringify(output.summary.events)).not.toContain("binary_data");
  });
  it("identifies resource bytes across replies without mutating the original events", () => {
    const first = new ThalovantEvent("mycroft.audio.queue", { binary_data: "01ff" });
    const second = new ThalovantEvent("mycroft.audio.queue", { binary_data: "02ff" });
    const firstOutput = runtimeReplyContent(reply([first]), true);
    const secondOutput = runtimeReplyContent(reply([second]), true);
    expect(firstOutput.clips[0].type).toBe("resource");
    expect(secondOutput.clips[0].type).toBe("resource");
    if (firstOutput.clips[0].type !== "resource" || secondOutput.clips[0].type !== "resource") {
      throw new Error("Expected embedded resources");
    }
    expect(firstOutput.clips[0].resource.uri).not.toBe(secondOutput.clips[0].resource.uri);
    expect(runtimeReplyContent(reply([first]), true).clips).toEqual(firstOutput.clips);
    expect(first.data.binary_data).toBe("01ff");
    expect(second.data.binary_data).toBe("02ff");
  });
});
