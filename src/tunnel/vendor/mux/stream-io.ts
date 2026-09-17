// Copied from @ora-ai/tunnel-protocol (tunnel-protocol-v0.2.0). DO NOT EDIT BY HAND.
// See ../index.ts for why this is a copy and how to update it.

import { PROTOCOL_ERROR_CODES, ProtocolError } from "../errors.js";
import type { ResponseHeadersPayload } from "../schemas.js";
import { AsyncQueue } from "./async-queue.js";
import type { TunnelStream } from "./stream.js";

/**
 * Bridges between TunnelStream's callback surface and async/await shapes.
 * Each helper wires the stream's handler set exactly once — never combine two
 * of them on the same stream.
 */

/**
 * Accepting side (connector): consume the incoming request body.
 * Wires onData/onEnd/onReset.
 */
export function streamBody(stream: TunnelStream): AsyncIterable<Uint8Array> {
  const queue = new AsyncQueue<Uint8Array>();
  stream.setHandlers({
    // Frames borrow the receive buffer — copy before handing to consumers.
    onData: (chunk) => queue.push(Uint8Array.from(chunk)),
    onEnd: () => queue.end(),
    onReset: (reset) =>
      queue.fail(new ProtocolError(PROTOCOL_ERROR_CODES.streamReset, `${reset.code}: ${reset.message}`)),
  });
  return queue;
}

export interface ProxiedResponse {
  headers: Promise<ResponseHeadersPayload>;
  body: AsyncIterable<Uint8Array>;
}

/**
 * Initiating side (session): await the response head, then stream its body.
 * Wires onHeaders/onData/onEnd/onReset. `timeoutMs` bounds the wait for
 * HEADERS only — body streaming is bounded by the connection, not a timer.
 */
export function proxiedResponse(stream: TunnelStream, timeoutMs: number): ProxiedResponse {
  const queue = new AsyncQueue<Uint8Array>();
  let settled = false;
  let resolveHeaders!: (head: ResponseHeadersPayload) => void;
  let rejectHeaders!: (error: Error) => void;
  const headers = new Promise<ResponseHeadersPayload>((resolve, reject) => {
    resolveHeaders = resolve;
    rejectHeaders = reject;
  });

  const timer = setTimeout(() => {
    if (settled) return;
    // sendReset notifies local handlers too, so the onReset path below
    // rejects the headers promise and fails the body queue.
    stream.sendReset(PROTOCOL_ERROR_CODES.timeout, `no response headers within ${timeoutMs}ms`);
  }, timeoutMs);
  timer.unref?.();

  stream.setHandlers({
    onHeaders: (head) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveHeaders(head);
    },
    onData: (chunk) => queue.push(Uint8Array.from(chunk)),
    onEnd: () => queue.end(),
    onReset: (reset) => {
      clearTimeout(timer);
      const error = new ProtocolError(
        PROTOCOL_ERROR_CODES.streamReset,
        `${reset.code}: ${reset.message}`,
      );
      if (!settled) {
        settled = true;
        rejectHeaders(error);
      }
      queue.fail(error);
    },
  });

  return { headers, body: queue };
}

/**
 * Send a body over the stream and half-close. On failure (source threw,
 * stream reset underneath us) the stream is RESET rather than left dangling.
 */
export async function pumpBody(
  stream: TunnelStream,
  body: AsyncIterable<Uint8Array>,
): Promise<void> {
  try {
    for await (const chunk of body) {
      stream.sendData(chunk);
    }
    stream.sendEnd();
  } catch (error) {
    stream.sendReset(
      PROTOCOL_ERROR_CODES.forwardError,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
