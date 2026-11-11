import { describe, expect, it } from "vitest";
import { announcementDigest, announcementOutput, checkAnnouncementText, resolveTargets } from "../src/intercom-output.js";

describe("intercom output helpers", () => {
  it("trims and counts characters, not bytes", () => {
    expect(checkAnnouncementText("  Bonjour à tous  ")).toBe("Bonjour à tous");
    expect(checkAnnouncementText("é".repeat(280))).toHaveLength(280);
    expect(() => checkAnnouncementText("é".repeat(281))).toThrow(/280/);
    expect(announcementDigest("été").textLen).toBe(3);
  });

  it("allows emoji joiners and refuses control and direction characters", () => {
    expect(() => checkAnnouncementText("Family \u{1F468}\u200D\u{1F469} dinner")).not.toThrow();
    for (const bad of ["a\tb", "a\nb", "a\u0000b", "a\u2028b", "a\u202Eb", "a<b", "a>b"]) {
      expect(() => checkAnnouncementText(bad), JSON.stringify(bad)).toThrow(/plain text/);
    }
  });

  it("resolves exactly one explicit target kind", () => {
    expect(resolveTargets({ allowAll: true })).toEqual({ all: true });
    expect(resolveTargets({ groups: ["kids"] })).toEqual({ groups: ["kids"] });
    expect(resolveTargets({ speakers: [], rooms: ["kitchen"] })).toEqual({ rooms: ["kitchen"] });
    expect(() => resolveTargets({})).toThrow(/allowAll/);
    expect(() => resolveTargets({ rooms: ["a"], groups: ["b"] })).toThrow(/one kind/);
  });

  it("whitelists and summarizes an announcement", () => {
    const out = announcementOutput({ id: "x", status: "failed", deliveries: [], text: "no" }, (v) => v) as Record<string, unknown>;
    expect(out).not.toHaveProperty("text");
    expect(out.summary).toBe("failed: no speakers.");
  });
});
