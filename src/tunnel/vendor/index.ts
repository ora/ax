// The CLIENT half of ora's tunnel wire protocol, copied from
// @ora-ai/tunnel-protocol at tag tunnel-protocol-v0.2.0 (oramono,
// packages/node/tunnel-protocol/src). DO NOT EDIT BY HAND.
//
// Why a copy and not the dependency: the package validates its JSON control
// frames with zod, and classic zod is not tree-shakeable - bundling it made
// the bin 4.8x larger (120 KB -> 580 KB) for five small schemas. Every file
// here except ./schemas.ts is verbatim upstream code with one marked
// deviation (the zod schema type import); ./schemas.ts is a hand-written
// replacement with the same names, shapes and semantics.
//
// What pins the copy to the real thing: the package stays a devDependency
// and the test suite runs this connector against ITS TunnelSession (the
// server half) over its in-memory socket pair, so a frame or schema that
// drifts from upstream fails the handshake tests here. Re-copy the whole
// directory whenever the protocol moves (a new tag), then rewrite only the
// three zod import lines and re-run the tests.
export { PROTOCOL_ERROR_CODES, ProtocolError } from "./errors.js";
export { TUNNEL_SUBPROTOCOL_V1, V1Codec } from "./codec/v1.js";
export type { ISocket } from "./socket.js";
export {
  TunnelConnector,
  type LocalForwarder,
  type LocalRequest,
  type LocalResponse,
} from "./connector.js";
export type { HeaderMap } from "./schemas.js";
