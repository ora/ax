// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ../index.ts for why this is a copy and how to update it.

// ax deviation: the zod schema type is replaced by the hand-written PayloadSchema (see ../schemas.ts).
import type { PayloadSchema as ZodType } from "../schemas.js";
import type { Frame, FrameType } from "../frames.js";

/**
 * A protocol version: how frames serialize and how JSON payloads are
 * validated. Version negotiation is WebSocket subprotocol selection — the
 * client offers its codecs' subprotocols, the server picks one from its
 * registry. A future v2 is a NEW codec registered here (Open/Closed); v1 is
 * never edited.
 */
export interface IFrameCodec {
  /** The WebSocket subprotocol this codec answers to, e.g. "ora-tunnel.v1". */
  readonly subprotocol: string;
  readonly maxFrame: number;
  encode(frame: Frame): Uint8Array;
  decode(data: Uint8Array): Frame;
  /** Encode a JSON control payload into a ready-to-send frame. */
  encodeJson(type: FrameType, streamId: number, payload: unknown): Uint8Array;
  /** Parse + schema-validate a JSON payload; throws ProtocolError on garbage. */
  decodeJson<T>(frame: Frame, schema: ZodType<T>): T;
}

/** Registry of codecs keyed by subprotocol (Registry of Strategies). */
export class CodecRegistry {
  private readonly bySubprotocol = new Map<string, IFrameCodec>();

  register(codec: IFrameCodec): void {
    if (this.bySubprotocol.has(codec.subprotocol)) {
      throw new Error(`duplicate codec for subprotocol ${codec.subprotocol}`);
    }
    this.bySubprotocol.set(codec.subprotocol, codec);
  }

  resolve(subprotocol: string): IFrameCodec {
    const codec = this.bySubprotocol.get(subprotocol);
    if (!codec) throw new Error(`no codec for subprotocol ${subprotocol}`);
    return codec;
  }

  has(subprotocol: string): boolean {
    return this.bySubprotocol.has(subprotocol);
  }

  /** All supported subprotocols, in registration order (offer/accept lists). */
  subprotocols(): readonly string[] {
    return [...this.bySubprotocol.keys()];
  }
}
