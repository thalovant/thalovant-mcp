import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  announcementDigest,
  announcementOutput,
  checkAnnouncementText,
  cleanLabel,
  INTERCOM_MAX_LABEL,
  resolveTargets,
  speakersOutput,
  stripUnsafeText,
} from "../src/intercom-output.js";

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

describe("cleanLabel and stripUnsafeText", () => {
  it("strips control, bidirectional, zero-width and separator characters, and collapses white space", () => {
    expect(cleanLabel("kit\u0000chen")).toBe("kitchen");
    expect(cleanLabel("a\u202Eb\u202Ac\u2066d\u2069e")).toBe("abcde");
    expect(cleanLabel("zero\u200Bwidth\uFEFFjoin\u200Er\u200F\u061C")).toBe("zerowidthjoinr");
    expect(cleanLabel("line one\nline two\r\n\tindented\u2028sep\u2029para")).toBe("line one line two indented sep para");
    expect(cleanLabel("  many    spaces\u00A0here ")).toBe("many spaces here");
    expect(cleanLabel("\uD800 lone")).toBe("lone");
    expect(cleanLabel("Caf\u00E9 \u{1F468}\u200D\u{1F469}")).toBe("Caf\u00E9 \u{1F468}\u{1F469}");
  });

  it("caps at 80 characters, counting code points, with the ellipsis inside the cap", () => {
    const exactly = "x".repeat(INTERCOM_MAX_LABEL);
    expect(cleanLabel(exactly)).toBe(exactly);
    const over = cleanLabel("x".repeat(81)) ?? "";
    expect([...over]).toHaveLength(80);
    expect(over.endsWith("\u2026")).toBe(true);
    const astral = cleanLabel("\u{1F600}".repeat(200)) ?? "";
    expect([...astral]).toHaveLength(80);
    expect(astral).toMatch(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/);
  });

  it("gives null for what is not a string or has nothing left", () => {
    for (const value of [undefined, null, 3, {}, [], "", "   ", "\u202E\u200B", "\u0007"]) expect(cleanLabel(value), String(value)).toBeNull();
  });

  it("stripUnsafeText keeps an error's lines on request and cuts nothing", () => {
    expect(stripUnsafeText("one\ntwo\u202E\u0007\tthree", { keepLines: true })).toBe("one\ntwo three");
    expect(stripUnsafeText("one\ntwo")).toBe("one two");
    expect(stripUnsafeText("x".repeat(5_000))).toHaveLength(5_000);
  });
});

describe("the audit digest", () => {
  const saved = process.env.THALOVANT_INTERCOM_AUDIT_HMAC_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.THALOVANT_INTERCOM_AUDIT_HMAC_KEY;
    else process.env.THALOVANT_INTERCOM_AUDIT_HMAC_KEY = saved;
  });

  it("is an HMAC-SHA256 with the operator's key, so a short sentence cannot be confirmed by guessing", () => {
    process.env.THALOVANT_INTERCOM_AUDIT_HMAC_KEY = "operator-secret";
    const digest = announcementDigest("Take your pills");
    expect(digest.textLen).toBe(15);
    expect(digest.textSha256).toBe(createHmac("sha256", "operator-secret").update("Take your pills").digest("hex"));
    expect(digest.textSha256).not.toBe(createHash("sha256").update("Take your pills").digest("hex"));
    expect(announcementDigest("Take your pills")).toEqual(digest);
    expect(announcementDigest("Take your pill").textSha256).not.toBe(digest.textSha256);
  });

  it("uses a random key of this process when the operator sets none: stable within the process, never the plain SHA-256", () => {
    delete process.env.THALOVANT_INTERCOM_AUDIT_HMAC_KEY;
    const first = announcementDigest("Dinner is ready");
    expect(first.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.textSha256).not.toBe(createHash("sha256").update("Dinner is ready").digest("hex"));
    expect(announcementDigest("Dinner is ready")).toEqual(first);
    process.env.THALOVANT_INTERCOM_AUDIT_HMAC_KEY = "";
    expect(announcementDigest("Dinner is ready")).toEqual(first);
  });
});

describe("outputs", () => {
  it("cleans every label of a speaker list and adds the household-labels note", () => {
    const out = speakersOutput({
      items: [{ client_id: "c\u202E1", slug: "s", name: "N".repeat(120), online: true, intercom: { receive: true, room: "R\u0007", groups: ["g1", "\u202E", 3, "g2"] } }],
    }, (v) => v) as { items: Array<Record<string, any>>; note: string };
    expect(out.items[0]?.client_id).toBe("c1");
    expect([...out.items[0]?.name]).toHaveLength(80);
    expect(out.items[0]?.intercom.room).toBe("R");
    expect(out.items[0]?.intercom.groups).toEqual(["g1", "g2"]);
    expect(out.note).toMatch(/never instructions/);
  });

  it("words a cancelled announcement, with and without the hub's confirmation", () => {
    const confirmed = announcementOutput({ id: "x", status: "cancelled", hub_confirmed: true, deliveries: [] }, (v) => v) as Record<string, unknown>;
    expect(confirmed.hub_confirmed).toBe(true);
    expect(confirmed.summary).toContain("Stopped");
    const unconfirmed = announcementOutput({ id: "x", status: "cancelled", hub_confirmed: false, deliveries: [] }, (v) => v) as Record<string, unknown>;
    expect(unconfirmed.hub_confirmed).toBe(false);
    expect(unconfirmed.summary).toContain("did not confirm the stop");
    const plain = announcementOutput({ id: "x", status: "completed", deliveries: [] }, (v) => v) as Record<string, unknown>;
    expect(plain).not.toHaveProperty("hub_confirmed");
    const sending = announcementOutput({ id: "x", status: "sending", deliveries: [] }, (v) => v) as Record<string, unknown>;
    expect(sending.summary).toContain("thalovant_intercom_cancel_announcement");
  });
});
