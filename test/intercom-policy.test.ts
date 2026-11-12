/**
 * The Intercom guardrails of src/intercom-policy.ts that need no server: the
 * hub allowlist, the sliding-window rate cap, the confirmation text and the
 * elicitation capability check.
 */
import { describe, expect, it } from "vitest";
import {
  IntercomRateCap,
  IntercomRefusal,
  assertIntercomHubAllowed,
  confirmationMessage,
  describeTargets,
  intercomHubAllowlist,
  intercomRateLimits,
  supportsFormElicitation,
} from "../src/intercom-policy.js";

const HUB = "7a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
const OTHER = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

describe("hub allowlist", () => {
  it("allows any hub when unset or empty", () => {
    for (const value of [undefined, "", "  ", " , ,"]) {
      const env = value === undefined ? {} : { THALOVANT_INTERCOM_ALLOWED_HUBS: value };
      expect(intercomHubAllowlist(env)).toEqual({ configured: false, hubs: [], invalid: 0 });
      expect(() => assertIntercomHubAllowed(HUB, env)).not.toThrow();
    }
  });

  it("reads comma-separated UUIDs in any case, de-duplicated", () => {
    const list = intercomHubAllowlist({ THALOVANT_INTERCOM_ALLOWED_HUBS: ` ${HUB.toUpperCase()} ,${OTHER},${HUB},junk` });
    expect(list).toEqual({ configured: true, hubs: [HUB, OTHER], invalid: 1 });
    expect(() => assertIntercomHubAllowed(HUB, { THALOVANT_INTERCOM_ALLOWED_HUBS: OTHER })).toThrow(IntercomRefusal);
    expect(() => assertIntercomHubAllowed(HUB.toUpperCase(), { THALOVANT_INTERCOM_ALLOWED_HUBS: HUB })).not.toThrow();
  });

  it("fails closed when the list names nothing valid", () => {
    expect(() => assertIntercomHubAllowed(HUB, { THALOVANT_INTERCOM_ALLOWED_HUBS: "mine, theirs" })).toThrow(/THALOVANT_INTERCOM_ALLOWED_HUBS/);
  });

  it("does not list the allowed hubs in the refusal", () => {
    try {
      assertIntercomHubAllowed(HUB, { THALOVANT_INTERCOM_ALLOWED_HUBS: OTHER });
      expect.unreachable();
    } catch (error) {
      expect((error as IntercomRefusal).reason).toBe("hub_not_allowed");
      expect((error as Error).message).not.toContain(OTHER);
    }
  });
});

describe("rate limits from the environment", () => {
  it("defaults to 20 a minute and 5 urgent an hour, and honours positive integers", () => {
    expect(intercomRateLimits({})).toEqual({ normalPerMinute: 20, urgentPerHour: 5 });
    expect(intercomRateLimits({ THALOVANT_INTERCOM_RATE_NORMAL_PER_MINUTE: "7", THALOVANT_INTERCOM_RATE_URGENT_PER_HOUR: "2" })).toEqual({ normalPerMinute: 7, urgentPerHour: 2 });
  });

  it("keeps the default for zero, negative, fractional-looking junk and empty values", () => {
    for (const value of ["0", "-3", "abc", "", " "]) {
      expect(intercomRateLimits({ THALOVANT_INTERCOM_RATE_NORMAL_PER_MINUTE: value, THALOVANT_INTERCOM_RATE_URGENT_PER_HOUR: value }), JSON.stringify(value)).toEqual({ normalPerMinute: 20, urgentPerHour: 5 });
    }
  });
});

describe("IntercomRateCap", () => {
  const limits = { normalPerMinute: 3, urgentPerHour: 2 };

  it("allows the limit, then refuses with the time until a slot frees, and slides", () => {
    let now = 1_000_000;
    const cap = new IntercomRateCap(() => now);
    cap.consume("p", "normal", limits);
    now += 10_000;
    cap.consume("p", "normal", limits);
    now += 10_000;
    cap.consume("p", "normal", limits);
    expect(cap.retryAfterSeconds("p", "normal", limits)).toBe(40);
    expect(() => cap.consume("p", "normal", limits)).toThrow(/3 normal announcement\(s\) a minute/);
    now += 39_000;
    expect(cap.retryAfterSeconds("p", "normal", limits)).toBe(1);
    now += 1_000;
    // The first one (at t0) is a minute old: one slot is free again.
    expect(cap.retryAfterSeconds("p", "normal", limits)).toBe(0);
    cap.consume("p", "normal", limits);
    expect(cap.retryAfterSeconds("p", "normal", limits)).toBeGreaterThan(0);
  });

  it("counts normal and urgent apart, and each principal apart", () => {
    const cap = new IntercomRateCap(() => 5_000);
    for (let i = 0; i < 3; i += 1) cap.consume("a", "normal", limits);
    expect(() => cap.consume("a", "normal", limits)).toThrow(IntercomRefusal);
    cap.consume("a", "urgent", limits);
    cap.consume("b", "normal", limits);
    cap.consume("a", "urgent", limits);
    expect(() => cap.consume("a", "urgent", limits)).toThrow(/2 urgent announcement\(s\) an hour/);
  });

  it("measures urgent over an hour, and refuseIfReached counts nothing", () => {
    let now = 0;
    const cap = new IntercomRateCap(() => now);
    cap.consume("p", "urgent", limits);
    cap.consume("p", "urgent", limits);
    for (let i = 0; i < 10; i += 1) expect(() => cap.refuseIfReached("p", "urgent", limits)).toThrow(IntercomRefusal);
    now += 3_599_000;
    expect(cap.retryAfterSeconds("p", "urgent", limits)).toBe(1);
    now += 1_000;
    expect(() => cap.refuseIfReached("p", "urgent", limits)).not.toThrow();
    // Only the explicit consume uses a slot.
    for (let i = 0; i < 5; i += 1) cap.refuseIfReached("p", "urgent", limits);
    cap.consume("p", "urgent", limits);
    cap.consume("p", "urgent", limits);
    expect(() => cap.consume("p", "urgent", limits)).toThrow(IntercomRefusal);
  });

  it("forgets principals whose window has passed, so rows do not pile up", () => {
    let now = 0;
    const cap = new IntercomRateCap(() => now);
    for (let i = 0; i < 300; i += 1) cap.consume(`p${i}`, "normal", limits);
    const rows = (): number => (cap as unknown as { normal: Map<string, number[]> }).normal.size;
    expect(rows()).toBe(300);
    now += 61_000;
    cap.consume("late", "normal", limits);
    expect(rows()).toBe(1);
  });

  it("carries a reason the audit log can use", () => {
    const cap = new IntercomRateCap(() => 0);
    const tight = { normalPerMinute: 1, urgentPerHour: 1 };
    cap.consume("p", "normal", tight);
    try {
      cap.consume("p", "normal", tight);
      expect.unreachable();
    } catch (error) {
      expect((error as IntercomRefusal).reason).toBe("rate_limited");
    }
  });
});

describe("what the person is shown", () => {
  it("summarises the targets, cleaning names and showing at most ten", () => {
    expect(describeTargets({ all: true })).toContain("EVERY speaker");
    expect(describeTargets({ rooms: ["kitchen"] })).toBe("1 room: kitchen");
    expect(describeTargets({ groups: ["a", "b"] })).toBe("2 groups: a, b");
    expect(describeTargets({ speakers: ["k‮itchen"] })).toBe("1 speaker: kitchen");
    const many = describeTargets({ speakers: Array.from({ length: 13 }, (_, i) => `s${i}`) });
    expect(many).toContain("13 speakers: s0, s1");
    expect(many).toContain("s9 and 3 more");
    expect(many).not.toContain("s10");
  });

  it("names hub, priority, targets and text, and why the person is asked", () => {
    const message = confirmationMessage({
      hubId: HUB, text: "Dinner is ready", targets: { rooms: ["kitchen"] }, priority: "urgent",
      repeat: { times: 3, interval_seconds: 20 }, reasons: ["an urgent announcement"],
    });
    expect(message).toContain("an urgent announcement needs your confirmation");
    expect(message).toContain(`Hub: ${HUB}`);
    expect(message).toContain("Priority: URGENT (said 3 time(s), 20 s apart");
    expect(message).toContain("ignores do-not-disturb");
    expect(message).toContain("Targets: 1 room: kitchen");
    expect(message).toContain('Text: "Dinner is ready"');
    expect(message).toContain("not a certified safety system");
    const single = confirmationMessage({ hubId: HUB, text: "x", targets: { all: true }, priority: "urgent", reasons: ["a", "b"] });
    expect(single).toContain("Priority: URGENT (ignores do-not-disturb)");
    expect(single).toContain("a and b needs your confirmation");
  });
});

describe("supportsFormElicitation", () => {
  it("accepts form, and the legacy empty object; refuses none and url-only", () => {
    expect(supportsFormElicitation({ form: {} })).toBe(true);
    expect(supportsFormElicitation({ form: {}, url: {} })).toBe(true);
    expect(supportsFormElicitation({})).toBe(true);
    expect(supportsFormElicitation(undefined)).toBe(false);
    expect(supportsFormElicitation({ url: {} })).toBe(false);
  });
});
