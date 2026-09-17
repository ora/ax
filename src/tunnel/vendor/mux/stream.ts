// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ../index.ts for why this is a copy and how to update it.

import type { IFrameCodec } from "../codec/codec.js";
import { PROTOCOL_ERROR_CODES, ProtocolError } from "../errors.js";
import { type Frame, FrameType } from "../frames.js";
import {
  resetSchema,
  responseHeadersSchema,
  type HeaderMap,
  type ResetPayload,
  type ResponseHeadersPayload,
} from "../schemas.js";

/** How a stream puts bytes on the wire — implemented by the Multiplexer. */
export interface FrameWriter {
  writeFrame(bytes: Uint8Array): void;
}

export interface StreamHandlers {
  onHeaders?: (head: ResponseHeadersPayload) => void;
  onData?: (chunk: Uint8Array) => void;
  onEnd?: () => void;
  onReset?: (reset: ResetPayload) => void;
}

/**
 * One multiplexed exchange over the tunnel connection: a request flowing
 * client-ward (DATA/END from the opener) and a response flowing back
 * (HEADERS/DATA/END), either side abortable with RESET.
 *
 * Pure per-stream state machine — no socket knowledge (writes go through the
 * injected FrameWriter), no request semantics (those live in connector/
 * session).
 */
export class TunnelStream {
  private localEnded = false;
  private remoteEnded = false;
  private resetPayload: ResetPayload | null = null;
  private readonly handlers: StreamHandlers = {};

  constructor(
    readonly id: number,
    private readonly codec: IFrameCodec,
    private readonly writer: FrameWriter,
    private readonly onFinalized: (stream: TunnelStream) => void,
  ) {}

  get isFinalized(): boolean {
    return this.resetPayload !== null || (this.localEnded && this.remoteEnded);
  }

  setHandlers(handlers: StreamHandlers): void {
    Object.assign(this.handlers, handlers);
  }

  /** Split into codec-sized frames and send. Throws if the sending side is done. */
  sendData(chunk: Uint8Array): void {
    this.assertWritable();
    const max = this.codec.maxFrame;
    for (let offset = 0; offset < chunk.byteLength; offset += max) {
      this.writer.writeFrame(
        this.codec.encode({
          type: FrameType.Data,
          streamId: this.id,
          payload: chunk.subarray(offset, Math.min(offset + max, chunk.byteLength)),
        }),
      );
    }
  }

  sendHeaders(head: ResponseHeadersPayload): void {
    this.assertWritable();
    this.writer.writeFrame(this.codec.encodeJson(FrameType.Headers, this.id, head));
  }

  sendEnd(): void {
    if (this.localEnded || this.resetPayload) return; // idempotent
    this.localEnded = true;
    this.writer.writeFrame(
      this.codec.encode({ type: FrameType.End, streamId: this.id, payload: new Uint8Array(0) }),
    );
    this.maybeFinalize();
  }

  sendReset(code: string, message = ""): void {
    if (this.resetPayload) return; // idempotent
    const payload = { code, message };
    this.resetPayload = payload;
    this.writer.writeFrame(this.codec.encodeJson(FrameType.Reset, this.id, payload));
    // A local abort must reach local consumers too (a pending headers await,
    // a body iterator) — not only the peer.
    this.handlers.onReset?.(payload);
    this.onFinalized(this);
  }

  /** Incoming frame dispatch — called only by the Multiplexer. */
  receive(frame: Frame): void {
    if (this.resetPayload) return; // frames racing a reset are dropped
    switch (frame.type) {
      case FrameType.Headers:
        this.handlers.onHeaders?.(this.codec.decodeJson(frame, responseHeadersSchema));
        return;
      case FrameType.Data:
        if (this.remoteEnded) return; // data after END is a peer bug; drop
        this.handlers.onData?.(frame.payload);
        return;
      case FrameType.End:
        if (this.remoteEnded) return;
        this.remoteEnded = true;
        this.handlers.onEnd?.();
        this.maybeFinalize();
        return;
      case FrameType.Reset: {
        const reset = this.codec.decodeJson(frame, resetSchema);
        this.resetPayload = reset;
        this.handlers.onReset?.(reset);
        this.onFinalized(this);
        return;
      }
      default:
        throw new ProtocolError(
          PROTOCOL_ERROR_CODES.badPayload,
          `frame type 0x${frame.type.toString(16)} is not valid on an open stream`,
        );
    }
  }

  /** Tear down without emitting wire frames (connection died underneath us). */
  failLocally(reset: ResetPayload): void {
    if (this.resetPayload) return;
    this.resetPayload = reset;
    this.handlers.onReset?.(reset);
    this.onFinalized(this);
  }

  private assertWritable(): void {
    if (this.resetPayload) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.streamReset,
        `stream ${this.id} was reset (${this.resetPayload.code})`,
      );
    }
    if (this.localEnded) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.streamClosed,
        `stream ${this.id} already ended locally`,
      );
    }
  }

  private maybeFinalize(): void {
    if (this.localEnded && this.remoteEnded) this.onFinalized(this);
  }
}

export type { HeaderMap };
