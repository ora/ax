// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ./index.ts for why this is a copy and how to update it.

import type { IFrameCodec } from "./codec/codec.js";
import { PROTOCOL_ERROR_CODES, ProtocolError } from "./errors.js";
import { CONNECTION_STREAM_ID, FrameType } from "./frames.js";
import { awaitControlFrame, DEFAULT_HANDSHAKE_TIMEOUT_MS } from "./handshake.js";
import { Multiplexer } from "./mux/multiplexer.js";
import { pumpBody, streamBody } from "./mux/stream-io.js";
import type { TunnelStream } from "./mux/stream.js";
import {
  helloAckSchema,
  type GoawayPayload,
  type HeaderMap,
  type HelloAckPayload,
  type HelloPayload,
  type OpenPayload,
} from "./schemas.js";
import type { ISocket } from "./socket.js";

export interface LocalRequest {
  method: string;
  path: string;
  headers: HeaderMap;
  body: AsyncIterable<Uint8Array>;
}

export interface LocalResponse {
  status: number;
  headers: HeaderMap;
  body: AsyncIterable<Uint8Array>;
}

/**
 * The connector's ONLY egress: forward one request to the local dev server.
 *
 * Security invariant: implementations are constructed BOUND to the
 * HELLO-declared target — a LocalRequest carries no host/port, so nothing the
 * server sends can steer the connector anywhere else on the client's machine
 * or network.
 */
export interface LocalForwarder {
  forward(request: LocalRequest): Promise<LocalResponse>;
}

export interface TunnelConnectorOptions {
  /** An already-connected socket (dialer is the consumer's concern). */
  socket: ISocket;
  codec: IFrameCodec;
  forwarder: LocalForwarder;
  hello: HelloPayload;
  handshakeTimeoutMs?: number;
  onGoaway?: (goaway: GoawayPayload) => void;
  onConnectionClosed?: (reason: ProtocolError) => void;
}

/**
 * CLIENT half of a tunnel connection: performs the HELLO handshake, then
 * answers server-opened streams by forwarding each request to the local
 * target and streaming the response back.
 */
export class TunnelConnector {
  private mux: Multiplexer | null = null;

  constructor(private readonly opts: TunnelConnectorOptions) {}

  /** Handshake and start serving. Resolves with the negotiated HELLO_ACK. */
  async start(): Promise<HelloAckPayload> {
    if (this.mux) throw new Error("connector already started");
    const { socket, codec, hello } = this.opts;
    const ackPromise = awaitControlFrame(
      socket,
      codec,
      FrameType.HelloAck,
      helloAckSchema,
      this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    socket.send(codec.encodeJson(FrameType.Hello, CONNECTION_STREAM_ID, hello));
    const ack = await ackPromise;

    this.mux = new Multiplexer(socket, {
      codec,
      maxStreams: ack.maxStreams,
      onOpen: (stream, open) => void this.serve(stream, open),
      onGoaway: this.opts.onGoaway,
      onConnectionClosed: this.opts.onConnectionClosed,
    });
    this.mux.start();
    return ack;
  }

  get activeStreamCount(): number {
    return this.mux?.activeStreamCount ?? 0;
  }

  close(code?: number, reason?: string): void {
    (this.mux ?? this.opts.socket).close(code, reason);
  }

  private async serve(stream: TunnelStream, open: OpenPayload): Promise<void> {
    try {
      const response = await this.opts.forwarder.forward({
        method: open.method,
        path: open.path,
        headers: open.headers,
        body: streamBody(stream),
      });
      stream.sendHeaders({ status: response.status, headers: response.headers });
      await pumpBody(stream, response.body);
    } catch (error) {
      // pumpBody already RESET on its own failures; this also covers the
      // forwarder rejecting before headers were sent. sendReset is idempotent.
      try {
        stream.sendReset(
          PROTOCOL_ERROR_CODES.forwardError,
          error instanceof Error ? error.message : String(error),
        );
      } catch {
        // stream/connection already gone — nothing to clean up
      }
    }
  }
}
