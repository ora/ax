// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ./index.ts for why this is a copy and how to update it.

// ax deviation: the zod schema type is replaced by the hand-written PayloadSchema (see ./schemas.ts).
import type { PayloadSchema as ZodType } from "./schemas.js";
import type { IFrameCodec } from "./codec/codec.js";
import { PROTOCOL_ERROR_CODES, ProtocolError } from "./errors.js";
import { CONNECTION_STREAM_ID, type FrameType } from "./frames.js";
import type { ISocket } from "./socket.js";

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Await exactly one connection-level control frame (HELLO or HELLO_ACK),
 * validated against its schema. Used by both handshake halves; the socket's
 * message handler is consumed and must be re-pointed (at the Multiplexer)
 * afterwards.
 */
export function awaitControlFrame<T>(
  socket: ISocket,
  codec: IFrameCodec,
  expectedType: FrameType,
  schema: ZodType<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        socket.close(1002, PROTOCOL_ERROR_CODES.handshakeTimeout);
        reject(
          new ProtocolError(
            PROTOCOL_ERROR_CODES.handshakeTimeout,
            `no handshake frame within ${timeoutMs}ms`,
          ),
        );
      });
    }, timeoutMs);
    timer.unref?.();

    socket.onError((error) => settle(() => reject(error)));
    socket.onClose((code, reason) =>
      settle(() =>
        reject(
          new ProtocolError(
            PROTOCOL_ERROR_CODES.connectionClosed,
            `connection closed during handshake (${code}${reason ? `: ${reason}` : ""})`,
          ),
        ),
      ),
    );
    socket.onMessage((data) => {
      settle(() => {
        try {
          const frame = codec.decode(data);
          if (frame.streamId !== CONNECTION_STREAM_ID || frame.type !== expectedType) {
            throw new ProtocolError(
              PROTOCOL_ERROR_CODES.handshakeProtocol,
              `expected handshake frame 0x${expectedType.toString(16)}, got 0x${frame.type.toString(16)} on stream ${frame.streamId}`,
            );
          }
          resolve(codec.decodeJson(frame, schema));
        } catch (error) {
          socket.close(1002, PROTOCOL_ERROR_CODES.handshakeProtocol);
          reject(error);
        }
      });
    });
  });
}
