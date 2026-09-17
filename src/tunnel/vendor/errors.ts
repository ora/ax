// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ./index.ts for why this is a copy and how to update it.

/**
 * Protocol-level failure with a stable machine-readable code.
 *
 * Codes are part of the wire contract (they travel in RESET/GOAWAY payloads
 * and in thrown errors on both sides), so treat additions as protocol changes
 * and never repurpose an existing code.
 */
export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Well-known ProtocolError / RESET / GOAWAY codes used by this package. */
export const PROTOCOL_ERROR_CODES = {
  frameTooShort: "FRAME_TOO_SHORT",
  frameTooLarge: "FRAME_TOO_LARGE",
  frameLengthMismatch: "FRAME_LENGTH_MISMATCH",
  unknownFrameType: "UNKNOWN_FRAME_TYPE",
  badJson: "BAD_JSON",
  badPayload: "BAD_PAYLOAD",
  handshakeTimeout: "HANDSHAKE_TIMEOUT",
  handshakeProtocol: "HANDSHAKE_PROTOCOL",
  maxStreams: "MAX_STREAMS",
  streamClosed: "STREAM_CLOSED",
  streamReset: "STREAM_RESET",
  forwardError: "FORWARD_ERROR",
  connectionClosed: "CONNECTION_CLOSED",
  superseded: "SUPERSEDED",
  timeout: "TIMEOUT",
} as const;
