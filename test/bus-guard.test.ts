/**
 * The message types this server never sends (src/bus-guard.ts): the pure
 * checks, and the guard on a real ThalovantClient with a stand-in transport, so
 * what `thalovant_ask`, `thalovant_query`, `thalovant_send_action`,
 * `thalovant_send_code` and `thalovant_emit_event` call in the SDK is checked
 * without a hub.
 */
import { ThalovantClient, ThalovantIdentity } from "@thalovant/sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertBusTypeAllowed, busTypesOfFrame, guardRuntimeClient, refusedBusType } from "../src/bus-guard.js";

const REFUSED = [
  "thalovant.intercom.announce",
  "thalovant.intercom.cancel",
  "thalovant.intercom.policy.set",
  "thalovant.intercom.speakers",
  "thalovant.intercom.result",
  "THALOVANT.INTERCOM.ANNOUNCE",
  " thalovant.intercom.announce ",
  "thalovant．intercom．announce",
  "speak",
  "SPEAK",
  " speak\n",
  "ovos.utterance.speak",
  "Ovos.Utterance.Speak",
];

const ALLOWED = [
  "recognizer_loop:utterance",
  "my.custom.event",
  "thalovant.intercom",
  "thalovant.intercomx.announce",
  "thalovant.other.intercom.announce",
  "speaker.volume",
  "mycroft.speak.done",
  "ovos.utterance.handled",
  "",
];

describe("refusedBusType", () => {
  it.each(REFUSED)("refuses %j", (type) => {
    expect(refusedBusType(type)).toMatch(/never sent by this tool/);
    expect(() => assertBusTypeAllowed(type)).toThrow(/thalovant_intercom_announce/);
  });

  it.each(ALLOWED.filter((type) => type !== "thalovant.intercom"))("allows %j", (type) => {
    expect(refusedBusType(type)).toBeUndefined();
    expect(() => assertBusTypeAllowed(type)).not.toThrow();
  });

  it("refuses the bare protocol name too, and never refuses a non-string", () => {
    expect(refusedBusType("thalovant.intercom")).toMatch(/Intercom protocol/);
    for (const value of [undefined, null, 3, {}, []]) expect(refusedBusType(value)).toBeUndefined();
  });

  it("names the type without hostile characters, cut at 64 characters", () => {
    const reason = refusedBusType(`thalovant.intercom.‮\u0007${"x".repeat(200)}`) ?? "";
    expect(reason).not.toMatch(/[‮\u0007]/);
    expect(reason.length).toBeLessThan(500);
  });
});

describe("busTypesOfFrame", () => {
  it("reads the type of a bus frame and of the bus message inside a query, broadcast or propagate frame", () => {
    expect(busTypesOfFrame({ msg_type: "bus", payload: { type: "speak", data: {}, context: {} } })).toEqual(["speak"]);
    expect(busTypesOfFrame({ msg_type: "query", payload: { msg_type: "bus", payload: { type: "recognizer_loop:utterance", data: {} } } })).toEqual(["recognizer_loop:utterance"]);
    expect(busTypesOfFrame({ msg_type: "broadcast", payload: { msg_type: "bus", payload: { type: "thalovant.intercom.announce", data: {} } } })).toEqual(["thalovant.intercom.announce"]);
    expect(busTypesOfFrame({ msg_type: "hello", payload: { pubkey: "", site_id: "x" } })).toEqual([]);
  });

  it("never reads a sentence or a value inside data as a type", () => {
    expect(busTypesOfFrame({ msg_type: "bus", payload: { type: "recognizer_loop:utterance", data: { type: "speak", utterances: ["thalovant.intercom.announce"] } } })).toEqual(["recognizer_loop:utterance"]);
  });

  it("survives anything that is not a frame, and a payload that loops", () => {
    for (const value of [undefined, null, "x", 3, [], { payload: "x" }, { payload: [] }]) expect(busTypesOfFrame(value)).toEqual([]);
    const loop: Record<string, unknown> = { type: "speak" };
    loop.payload = loop;
    expect(busTypesOfFrame({ payload: loop }).length).toBeLessThanOrEqual(8);
  });
});

type Sent = { via: "emitBus" | "sendHiveMessage"; type: string };

/** A transport that connects at once and records what leaves it. */
function standIn(): { transport: EventTarget; sent: Sent[] } {
  const sent: Sent[] = [];
  const transport = new EventTarget() as EventTarget & Record<string, unknown>;
  transport.connect = async () => undefined;
  transport.disconnect = async () => undefined;
  transport.healthcheck = () => ({ connected: true, handshakeComplete: true });
  transport.emitBus = async (type: string) => { sent.push({ via: "emitBus", type }); };
  transport.sendHiveMessage = async (frame: unknown) => {
    sent.push({ via: "sendHiveMessage", type: busTypesOfFrame(frame).join(",") || String((frame as { msg_type?: unknown }).msg_type) });
  };
  return { transport, sent };
}

const IDENTITY = {
  accessKey: "key",
  password: "pw",
  host: "wss://hub.example.invalid",
  port: 5678,
  siteId: "site",
  mqtt: { endpoint: "mqtts://broker.example.invalid:8883", username: "user", password: "pw", topic_prefix: "hivemind/hub/key" },
};

function guardedClient() {
  const { transport, sent } = standIn();
  const identity = new ThalovantIdentity(IDENTITY as never);
  const client = guardRuntimeClient(new ThalovantClient(identity, { transport: transport as never }));
  return { client, sent, transport: transport as unknown as Record<string, (...args: unknown[]) => Promise<void>> };
}

describe("guardRuntimeClient on the SDK client the runtime tools use", () => {
  it("thalovant_emit_event: client.emit refuses the types and sends the others", async () => {
    const { client, sent } = guardedClient();
    for (const type of REFUSED) await expect(client.emit(type, { text: "hi" }), type).rejects.toThrow(/never sent by this tool/);
    expect(sent).toEqual([]);
    await client.emit("my.custom.event", {});
    expect(sent).toEqual([{ via: "emitBus", type: "my.custom.event" }]);
  });

  it("thalovant_send_action and thalovant_send_code: only recognizer_loop:utterance leaves the client", async () => {
    const { client, sent } = guardedClient();
    await client.sendAction("turn on the kitchen light");
    await client.sendCode("0123456789", { kind: "barcode" });
    expect(sent).toEqual([
      { via: "emitBus", type: "recognizer_loop:utterance" },
      { via: "emitBus", type: "recognizer_loop:utterance" },
    ]);
  });

  it("thalovant_ask: its utterance is the only message sent, and it passes the guard", async () => {
    const { client, sent } = guardedClient();
    await client.ask("what time is it", { timeoutMs: 1_000, replySettleMs: 0, emptyReplyWaitMs: 0 }).catch(() => undefined);
    expect(sent).toEqual([{ via: "emitBus", type: "recognizer_loop:utterance" }]);
  });

  it("thalovant_query: its query frame carries only recognizer_loop:utterance and passes the guard", async () => {
    const { client, sent } = guardedClient();
    await client.query("what time is it", { timeoutMs: 1_000, replySettleMs: 0 }).catch(() => undefined);
    expect(sent).toEqual([{ via: "sendHiveMessage", type: "recognizer_loop:utterance" }]);
  });

  it("refuses the types at the transport, where ask, query and send_action write, whatever called", async () => {
    const { client, sent, transport } = guardedClient();
    await expect(transport.emitBus("thalovant.intercom.announce", {}, {})).rejects.toThrow(/Intercom protocol/);
    await expect(transport.emitBus("speak", {}, {})).rejects.toThrow(/makes a speaker talk/);
    // The frame ask() would send with a refused type, and the ones query and the hive kinds send.
    await expect(transport.sendHiveMessage({ msg_type: "bus", payload: { type: "ovos.utterance.speak", data: {}, context: {} } })).rejects.toThrow(/makes a speaker talk/);
    await expect(transport.sendHiveMessage({ msg_type: "query", payload: { msg_type: "bus", payload: { type: "thalovant.intercom.cancel", data: {} } } })).rejects.toThrow(/Intercom protocol/);
    await expect(client.broadcast("thalovant.intercom.policy.set", { policies: {} })).rejects.toThrow(/Intercom protocol/);
    await expect(client.propagate("speak", { utterance: "hi" })).rejects.toThrow(/makes a speaker talk/);
    expect(sent).toEqual([]);
    // A hive frame of an allowed type, and the handshake's hello, still go out.
    await client.escalate("my.custom.event", {});
    await transport.sendHiveMessage({ msg_type: "hello", payload: { pubkey: "", site_id: "site" } });
    expect(sent.map((row) => row.via)).toEqual(["sendHiveMessage", "sendHiveMessage"]);
  });

  it("fails closed when the transport is not what the guard expects, so nothing runs unguarded", () => {
    const identity = new ThalovantIdentity(IDENTITY as never);
    expect(() => guardRuntimeClient({})).toThrow(/could not be guarded/);
    expect(() => guardRuntimeClient({ transport: null })).toThrow(/could not be guarded/);
    expect(() => guardRuntimeClient({ transport: {} })).toThrow(/could not be guarded/);
    // The installed SDK still has the members the guard wraps: an upgrade that renames them fails here.
    for (const protocol of ["wss", "https", "mqtt"] as const) {
      expect(() => guardRuntimeClient(new ThalovantClient(identity, { protocol })), protocol).not.toThrow();
    }
  });
});

describe("wiring in src/index.ts", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("builds every runtime client through guardRuntimeClient, so no runtime tool sends unguarded", () => {
    const constructions = source.match(/new ThalovantClient\(/g) ?? [];
    const guarded = source.match(/guardRuntimeClient\(new ThalovantClient\(/g) ?? [];
    expect(constructions.length).toBeGreaterThan(0);
    expect(guarded).toHaveLength(constructions.length);
  });

  it("checks thalovant_emit_event's eventType before it opens an identity", () => {
    const tool = source.slice(source.indexOf('"thalovant_emit_event"'), source.indexOf('"thalovant_wait_for_event"'));
    const check = tool.indexOf("assertBusTypeAllowed(eventType)");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(tool.indexOf("withRuntimeClient("));
  });
});
