// The ONE hand-written file in this directory. Everything else is a verbatim
// copy of @ora-ai/tunnel-protocol (see ./index.ts); this file replaces its
// zod schemas with plain validators of the same names, shapes and semantics
// (unknown keys stripped, defaults applied, first failure reported) so the
// bin does not carry zod. The server half in the test suite is the real
// package, so a divergence from the upstream schemas fails the handshake
// tests here rather than in production.

export interface PayloadSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

export type HeaderMap = Record<string, string | string[]>;
export interface TargetPayload {
  protocol: "http";
  host: string;
  port: number;
}
export interface HelloPayload {
  agentVersion: string;
  target: TargetPayload;
  maxStreams: number;
}
export interface HelloAckPayload {
  tunnelId: string;
  heartbeatMs: number;
  maxStreams: number;
  maxFrame: number;
}
export interface OpenPayload {
  method: string;
  path: string;
  headers: HeaderMap;
}
export interface ResponseHeadersPayload {
  status: number;
  headers: HeaderMap;
}
export interface ResetPayload {
  code: string;
  message: string;
}
export type GoawayPayload = ResetPayload;

class Invalid extends Error {}

function object(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Invalid(`${path}: expected object`);
  }
  return input as Record<string, unknown>;
}

function str(value: unknown, path: string, min = 0, max = Number.POSITIVE_INFINITY): string {
  if (typeof value !== "string") throw new Invalid(`${path}: expected string`);
  if (value.length < min) throw new Invalid(`${path}: expected at least ${min} characters`);
  if (value.length > max) throw new Invalid(`${path}: expected at most ${max} characters`);
  return value;
}

function int(value: unknown, path: string, min: number, max = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Invalid(`${path}: expected integer`);
  }
  if (value < min || value > max) throw new Invalid(`${path}: expected ${min}..${max}`);
  return value;
}

function headers(value: unknown, path: string): HeaderMap {
  if (value === undefined) return {};
  const out: HeaderMap = {};
  for (const [key, entry] of Object.entries(object(value, path))) {
    if (typeof entry === "string") out[key] = entry;
    else if (Array.isArray(entry) && entry.every((v) => typeof v === "string")) out[key] = entry;
    else throw new Invalid(`${path}.${key}: expected string or string[]`);
  }
  return out;
}

function schema<T>(parse: (input: unknown) => T): PayloadSchema<T> {
  return {
    safeParse(input) {
      try {
        return { success: true, data: parse(input) };
      } catch (error) {
        if (error instanceof Invalid) return { success: false, error: { message: error.message } };
        throw error;
      }
    },
  };
}

function target(input: unknown, path: string): TargetPayload {
  const o = object(input, path);
  if (o.protocol !== "http") throw new Invalid(`${path}.protocol: expected "http"`);
  return { protocol: "http", host: str(o.host, `${path}.host`, 1), port: int(o.port, `${path}.port`, 1, 65535) };
}

export const targetSchema: PayloadSchema<TargetPayload> = schema((input) => target(input, "target"));

/** Client -> server, the mandatory first frame. */
export const helloSchema: PayloadSchema<HelloPayload> = schema((input) => {
  const o = object(input, "hello");
  return {
    agentVersion: str(o.agentVersion, "hello.agentVersion", 1, 64),
    target: target(o.target, "hello.target"),
    maxStreams: o.maxStreams === undefined ? 32 : int(o.maxStreams, "hello.maxStreams", 1, 256),
  };
});

/** Server -> client, closes the handshake with the negotiated limits. */
export const helloAckSchema: PayloadSchema<HelloAckPayload> = schema((input) => {
  const o = object(input, "helloAck");
  return {
    tunnelId: str(o.tunnelId, "helloAck.tunnelId", 1),
    heartbeatMs: int(o.heartbeatMs, "helloAck.heartbeatMs", 1),
    maxStreams: int(o.maxStreams, "helloAck.maxStreams", 1),
    maxFrame: int(o.maxFrame, "helloAck.maxFrame", 1),
  };
});

/** Server -> client: serialized request head opening a stream. Paths only. */
export const openSchema: PayloadSchema<OpenPayload> = schema((input) => {
  const o = object(input, "open");
  const path = str(o.path, "open.path");
  if (!path.startsWith("/")) throw new Invalid('open.path: expected a path starting with "/"');
  return { method: str(o.method, "open.method", 1, 16), path, headers: headers(o.headers, "open.headers") };
});

/** Client -> server: serialized response head. */
export const responseHeadersSchema: PayloadSchema<ResponseHeadersPayload> = schema((input) => {
  const o = object(input, "responseHeaders");
  return {
    status: int(o.status, "responseHeaders.status", 100, 599),
    headers: headers(o.headers, "responseHeaders.headers"),
  };
});

function codeMessage(name: string): PayloadSchema<ResetPayload> {
  return schema((input) => {
    const o = object(input, name);
    return {
      code: str(o.code, `${name}.code`, 1, 64),
      message: o.message === undefined ? "" : str(o.message, `${name}.message`, 0, 1024),
    };
  });
}

export const resetSchema: PayloadSchema<ResetPayload> = codeMessage("reset");
export const goawaySchema: PayloadSchema<GoawayPayload> = codeMessage("goaway");
