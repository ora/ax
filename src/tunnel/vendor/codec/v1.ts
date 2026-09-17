// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ../index.ts for why this is a copy and how to update it.

// ax deviation: the zod schema type is replaced by the hand-written PayloadSchema (see ../schemas.ts).
import type { PayloadSchema as ZodType } from "../schemas.js";
import { PROTOCOL_ERROR_CODES, ProtocolError } from "../errors.js";
import {
  DEFAULT_MAX_FRAME,
  decodeFrame,
  encodeFrame,
  type Frame,
  FrameType,
} from "../frames.js";
import { CodecRegistry, type IFrameCodec } from "./codec.js";

export const TUNNEL_SUBPROTOCOL_V1 = "ora-tunnel.v1";

/**
 * Control (JSON) frames have a FIXED cap independent of the negotiated
 * `maxFrame`: `maxFrame` tunes DATA chunking granularity, while request/
 * response heads and handshake payloads must always fit regardless of how
 * small a consumer tunes data chunks.
 */
export const MAX_CONTROL_FRAME = DEFAULT_MAX_FRAME;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class V1Codec implements IFrameCodec {
  readonly subprotocol: string = TUNNEL_SUBPROTOCOL_V1;

  constructor(readonly maxFrame: number = DEFAULT_MAX_FRAME) {}

  encode(frame: Frame): Uint8Array {
    return encodeFrame(frame, this.capFor(frame.type));
  }

  decode(data: Uint8Array): Frame {
    // The type byte is validated inside decodeFrame; use the ceiling of both
    // caps here, then re-check the per-type cap once the type is known.
    const frame = decodeFrame(data, Math.max(this.maxFrame, MAX_CONTROL_FRAME));
    const cap = this.capFor(frame.type);
    if (frame.payload.byteLength > cap) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.frameTooLarge,
        `payload ${frame.payload.byteLength} exceeds max ${cap} for frame type 0x${frame.type.toString(16)}`,
      );
    }
    return frame;
  }

  encodeJson(type: FrameType, streamId: number, payload: unknown): Uint8Array {
    return this.encode({ type, streamId, payload: textEncoder.encode(JSON.stringify(payload)) });
  }

  decodeJson<T>(frame: Frame, schema: ZodType<T>): T {
    let raw: unknown;
    try {
      raw = JSON.parse(textDecoder.decode(frame.payload));
    } catch {
      throw new ProtocolError(PROTOCOL_ERROR_CODES.badJson, "frame payload is not valid JSON");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ProtocolError(PROTOCOL_ERROR_CODES.badPayload, parsed.error.message);
    }
    return parsed.data;
  }

  private capFor(type: FrameType): number {
    return type === FrameType.Data ? this.maxFrame : MAX_CONTROL_FRAME;
  }
}

/** The default registry a consumer starts from: v1 registered, nothing else. */
export function createDefaultCodecRegistry(): CodecRegistry {
  const registry = new CodecRegistry();
  registry.register(new V1Codec());
  return registry;
}
