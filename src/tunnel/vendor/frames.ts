// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ./index.ts for why this is a copy and how to update it.

import { PROTOCOL_ERROR_CODES, ProtocolError } from "./errors.js";

/**
 * Binary framing for ora-tunnel: fixed 9-byte header, then the payload.
 *
 * ```
 * byte 0      uint8   frame type
 * bytes 1-4   uint32  streamId (big-endian; 0 = connection-level)
 * bytes 5-8   uint32  payload length
 * bytes 9..   payload
 * ```
 *
 * Transport rule: exactly ONE frame per WebSocket binary message — the
 * message boundary is the frame boundary, so no cross-message reassembly
 * buffer exists on either side.
 *
 * This module is pure structure (bytes <-> Frame). Payload semantics live in
 * the codec (versioned) and schemas.
 */

export const FRAME_HEADER_SIZE = 9;
export const DEFAULT_MAX_FRAME = 64 * 1024;
/** streamId 0 addresses the connection itself (HELLO/HELLO_ACK/GOAWAY). */
export const CONNECTION_STREAM_ID = 0;

export enum FrameType {
  Hello = 0x01,
  HelloAck = 0x02,
  Open = 0x10,
  Headers = 0x11,
  Data = 0x12,
  End = 0x13,
  Reset = 0x14,
  Goaway = 0x20,
}

const KNOWN_FRAME_TYPES: ReadonlySet<number> = new Set(
  Object.values(FrameType).filter((v): v is number => typeof v === "number"),
);

export interface Frame {
  readonly type: FrameType;
  readonly streamId: number;
  readonly payload: Uint8Array;
}

export function encodeFrame(frame: Frame, maxPayload: number = DEFAULT_MAX_FRAME): Uint8Array {
  if (frame.payload.byteLength > maxPayload) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.frameTooLarge,
      `frame payload ${frame.payload.byteLength} exceeds max ${maxPayload}`,
    );
  }
  const buf = new Uint8Array(FRAME_HEADER_SIZE + frame.payload.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint8(0, frame.type);
  view.setUint32(1, frame.streamId, false);
  view.setUint32(5, frame.payload.byteLength, false);
  buf.set(frame.payload, FRAME_HEADER_SIZE);
  return buf;
}

export function decodeFrame(data: Uint8Array, maxPayload: number = DEFAULT_MAX_FRAME): Frame {
  if (data.byteLength < FRAME_HEADER_SIZE) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.frameTooShort,
      `frame is ${data.byteLength} bytes, header alone is ${FRAME_HEADER_SIZE}`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = view.getUint8(0);
  if (!KNOWN_FRAME_TYPES.has(type)) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.unknownFrameType,
      `unknown frame type 0x${type.toString(16)}`,
    );
  }
  const streamId = view.getUint32(1, false);
  const length = view.getUint32(5, false);
  if (length > maxPayload) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.frameTooLarge,
      `declared payload ${length} exceeds max ${maxPayload}`,
    );
  }
  if (data.byteLength !== FRAME_HEADER_SIZE + length) {
    throw new ProtocolError(
      PROTOCOL_ERROR_CODES.frameLengthMismatch,
      `declared payload ${length} but message carries ${data.byteLength - FRAME_HEADER_SIZE}`,
    );
  }
  return { type, streamId, payload: data.subarray(FRAME_HEADER_SIZE) };
}
