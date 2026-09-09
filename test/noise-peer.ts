import { randomBytes } from "node:crypto";
import {
  buildPrologue, canonicalJson, derivePsk, NoiseHandshake, NoiseSession,
  noiseProtocolName, x25519PublicKey,
} from "@thalovant/sdk";

// Independent responder driving the deployed r8 envelope through the public
// Noise primitives. The MCP test supplies real TLS/form/poll delivery.
export function noisePeer(
  password: string,
  write: (payload: string | Uint8Array, binary: boolean) => void,
  key: Uint8Array = randomBytes(32),
  pinnedClient?: Uint8Array,
) {
  const nodeId = "mcp-test-hub";
  const hello = { node_id: nodeId, pubkey: "mcp-test-public" };
  const offer = {
    max_protocol_version: 3, binarize: false, encodings: [],
    noise: {
      patterns: pinnedClient ? ["KKpsk0", "XXpsk2"] : ["XXpsk2"],
      suites: ["25519_ChaChaPoly_SHA256", "25519_AESGCM_SHA256"],
    },
  };
  let handshake: NoiseHandshake | undefined;
  let session: NoiseSession | undefined;
  let pattern: string | undefined;
  return {
    publicKey: x25519PublicKey(key),
    get clientKey() { return session?.remoteStaticKey; },
    get pattern() { return pattern; },
    start() {
      write(JSON.stringify({ msg_type: "hello", payload: hello }), false);
      write(JSON.stringify({ msg_type: "shake", payload: offer }), false);
    },
    receive(raw: string | Uint8Array): Record<string, any> | undefined {
      if (session) {
        if (typeof raw === "string") throw new Error("plaintext after Noise");
        const frame = session.decryptFrame(raw);
        if (!frame.complete) return undefined;
        if (!frame.isJson) throw new Error("expected authenticated JSON frame");
        return JSON.parse(Buffer.from(frame.payload).toString("utf8"));
      }
      if (typeof raw !== "string") throw new Error("ciphertext before Noise");
      const message = JSON.parse(raw);
      if (message.msg_type !== "shake" || !message.payload?.noise?.msg) {
        throw new Error("application traffic before Noise");
      }
      const params = message.payload.noise;
      if (!handshake) {
        pattern = params.pattern;
        handshake = new NoiseHandshake(
          params.pattern, params.suite, derivePsk(password, nodeId),
          buildPrologue(hello, offer, noiseProtocolName(params.pattern, params.suite)),
          key, pinnedClient, false,
        );
        handshake.readMessage(Buffer.from(params.msg, "hex"));
        const reply = handshake.writeMessage(Buffer.from(canonicalJson({ encoding: "JSON-HEX" })));
        write(JSON.stringify({ msg_type: "shake", payload: { noise: { msg: Buffer.from(reply).toString("hex") } } }), false);
        if (handshake.isFinished) session = handshake.intoSession();
      } else {
        handshake.readMessage(Buffer.from(params.msg, "hex"));
        session = handshake.intoSession();
      }
      return undefined;
    },
    reply(payload: Record<string, unknown>) {
      if (!session) throw new Error("no authenticated peer");
      for (const frame of session.encryptMessage(Buffer.from(JSON.stringify({ msg_type: "bus", payload })), true)) {
        write(frame, true);
      }
    },
    replyQuery(queryId: string, payload: Record<string, unknown>) {
      if (!session) throw new Error("no authenticated peer");
      const message = { msg_type: "query", metadata: { query_id: queryId }, payload: { msg_type: "bus", payload } };
      for (const frame of session.encryptMessage(Buffer.from(JSON.stringify(message)), true)) {
        write(frame, true);
      }
    },
  };
}
