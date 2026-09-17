// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ./index.ts for why this is a copy and how to update it.

/**
 * Minimal transport abstraction the protocol runs over (Adapter seam).
 *
 * The tunnel-service adapts the `ws` library behind this; the client CLI
 * brings its own dialer. This package never imports a WebSocket
 * implementation — that keeps it dependency-free and lets tests run two
 * protocol halves over an in-memory pair.
 *
 * Handler semantics: each `on*` call REPLACES the previous handler (single
 * consumer — the handshake phase hands the socket over to the multiplexer).
 */
export interface ISocket {
  /** Send one protocol frame as one binary message. */
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued but not yet flushed — senders use this for backpressure. */
  readonly bufferedAmount: number;
  onMessage(handler: (data: Uint8Array) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
}
