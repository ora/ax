// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ../index.ts for why this is a copy and how to update it.

import type { IFrameCodec } from "../codec/codec.js";
import { PROTOCOL_ERROR_CODES, ProtocolError } from "../errors.js";
import { CONNECTION_STREAM_ID, type Frame, FrameType } from "../frames.js";
import { goawaySchema, openSchema, type GoawayPayload, type OpenPayload } from "../schemas.js";
import type { ISocket } from "../socket.js";
import { TunnelStream } from "./stream.js";

export interface MultiplexerOptions {
  codec: IFrameCodec;
  /** Cap on concurrently open streams, enforced on BOTH open directions. */
  maxStreams: number;
  /**
   * Accepting side only (the connector): invoked per incoming OPEN. When
   * absent, an incoming OPEN is a protocol violation and is RESET — in v1
   * only the server opens streams.
   */
  onOpen?: (stream: TunnelStream, open: OpenPayload) => void;
  onGoaway?: (goaway: GoawayPayload) => void;
  /** Connection ended (close or fatal protocol error); streams already failed. */
  onConnectionClosed?: (reason: ProtocolError) => void;
}

/**
 * Owns the socket after the handshake: routes frames to per-stream state
 * machines, allocates stream ids (odd, monotonic — server-initiated in v1),
 * enforces the stream cap, and fails every open stream when the connection
 * dies.
 */
export class Multiplexer {
  private readonly streams = new Map<number, TunnelStream>();
  private nextStreamId = 1;
  private goingAway = false;
  private closed = false;

  constructor(
    private readonly socket: ISocket,
    private readonly opts: MultiplexerOptions,
  ) {}

  /** Take over the socket. Call exactly once, after the handshake completes. */
  start(): void {
    this.socket.onMessage((data) => this.handleMessage(data));
    this.socket.onClose((code, reason) =>
      this.teardown(
        new ProtocolError(
          PROTOCOL_ERROR_CODES.connectionClosed,
          `connection closed (${code}${reason ? `: ${reason}` : ""})`,
        ),
      ),
    );
    this.socket.onError((error) =>
      this.teardown(new ProtocolError(PROTOCOL_ERROR_CODES.connectionClosed, error.message)),
    );
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  /** Initiating side (the session): open a stream with a request head. */
  openStream(open: OpenPayload): TunnelStream {
    if (this.closed || this.goingAway) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.connectionClosed,
        "connection is closed or draining",
      );
    }
    if (this.streams.size >= this.opts.maxStreams) {
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.maxStreams,
        `stream cap ${this.opts.maxStreams} reached`,
      );
    }
    const stream = this.createStream(this.nextStreamId);
    this.nextStreamId += 2;
    this.socket.send(this.opts.codec.encodeJson(FrameType.Open, stream.id, open));
    return stream;
  }

  goaway(code: string, message = ""): void {
    if (this.closed || this.goingAway) return;
    this.goingAway = true;
    this.socket.send(
      this.opts.codec.encodeJson(FrameType.Goaway, CONNECTION_STREAM_ID, { code, message }),
    );
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  private handleMessage(data: Uint8Array): void {
    let frame: Frame;
    try {
      frame = this.opts.codec.decode(data);
      this.dispatch(frame);
    } catch (error) {
      if (error instanceof ProtocolError) {
        // A malformed frame poisons the whole connection — fail closed.
        this.goaway(error.code, error.message);
        this.close(1002, error.code);
        this.teardown(error);
        return;
      }
      throw error;
    }
  }

  private dispatch(frame: Frame): void {
    if (frame.streamId === CONNECTION_STREAM_ID) {
      if (frame.type === FrameType.Goaway) {
        this.goingAway = true;
        this.opts.onGoaway?.(this.opts.codec.decodeJson(frame, goawaySchema));
      }
      // HELLO/HELLO_ACK after the handshake phase are ignored, not fatal.
      return;
    }
    if (frame.type === FrameType.Open) {
      this.handleOpen(frame);
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      // END/RESET for an already-finalized stream race normally; anything else
      // gets an explicit RESET so the peer can release its side.
      if (frame.type !== FrameType.End && frame.type !== FrameType.Reset) {
        this.socket.send(
          this.opts.codec.encodeJson(FrameType.Reset, frame.streamId, {
            code: PROTOCOL_ERROR_CODES.streamClosed,
            message: "unknown stream",
          }),
        );
      }
      return;
    }
    stream.receive(frame);
  }

  private handleOpen(frame: Frame): void {
    if (!this.opts.onOpen) {
      // v1: this side never accepts streams.
      this.socket.send(
        this.opts.codec.encodeJson(FrameType.Reset, frame.streamId, {
          code: PROTOCOL_ERROR_CODES.badPayload,
          message: "this side does not accept streams",
        }),
      );
      return;
    }
    if (this.goingAway) return; // draining: peer was told, drop new work
    const open = this.opts.codec.decodeJson(frame, openSchema);
    if (this.streams.size >= this.opts.maxStreams) {
      this.socket.send(
        this.opts.codec.encodeJson(FrameType.Reset, frame.streamId, {
          code: PROTOCOL_ERROR_CODES.maxStreams,
          message: `stream cap ${this.opts.maxStreams} reached`,
        }),
      );
      return;
    }
    const stream = this.createStream(frame.streamId);
    this.opts.onOpen(stream, open);
  }

  private createStream(id: number): TunnelStream {
    const writer = { writeFrame: (bytes: Uint8Array): void => this.socket.send(bytes) };
    const stream = new TunnelStream(id, this.opts.codec, writer, (s) => this.streams.delete(s.id));
    this.streams.set(id, stream);
    return stream;
  }

  private teardown(reason: ProtocolError): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of [...this.streams.values()]) {
      stream.failLocally({ code: reason.code, message: reason.message });
    }
    this.streams.clear();
    this.opts.onConnectionClosed?.(reason);
  }
}
