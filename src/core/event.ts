// Signed, content-addressed events: the only thing nodes exchange.
//
// Every change in the network (a message, a new channel, a role edit, a
// profile update) is an event signed by the Ed25519 key of the user who made
// it. Nodes verify every event independently and derive the same state from
// the same set of events, so no node has to trust another.

import { canonical, type KeyPair, sha256, sha256hex, signData, verifyData } from "./crypto.ts";
import { decodeTime, encodeRandom, isUlid, randomPart, ulidFrom } from "./ulid.ts";

export const PROTOCOL_VERSION = 1;

export interface StoatEvent {
  v: 1;
  /** sha256 (hex) of the canonical JSON of every other field except `sig` */
  id: string;
  scope: string;
  type: string;
  /** User id (ULID) of the author */
  author: string;
  /** Author's Ed25519 public key (base64url); must hash to the author id */
  key: string;
  /** Author's clock, milliseconds since epoch */
  ts: number;
  /** Causal dependencies (ids of events the author had seen), sorted */
  deps: string[];
  body: Record<string, unknown>;
  /** Ed25519 signature of `id` */
  sig: string;
}

export type UnsignedEvent = Omit<StoatEvent, "id" | "sig">;

/** Events that make up the replicated state of a server (ordered as a DAG). */
export const SERVER_STATE_TYPES = new Set([
  "server.create",
  "server.update",
  "server.delete",
  "server.permissions",
  "channel.create",
  "channel.update",
  "channel.delete",
  "channel.permissions",
  "role.create",
  "role.update",
  "role.delete",
  "role.ranks",
  "member.join",
  "member.leave",
  "member.kick",
  "member.edit",
  "ban.create",
  "ban.remove",
  "invite.create",
  "invite.delete",
  "emoji.create",
  "emoji.delete",
]);

/** Events that carry chat content (never referenced as state heads). */
export const CONTENT_TYPES = new Set([
  "message.send",
  "message.edit",
  "message.delete",
  "message.react",
  "message.unreact",
  "message.clear_reactions",
  "message.pin",
  "message.unpin",
]);

export const DM_STATE_TYPES = new Set(["relation.set"]);

export const USER_TYPES = new Set(["user.profile"]);

export const LIMITS = {
  bodyBytes: 48 * 1024,
  deps: 64,
  futureSkewMs: 10 * 60 * 1000,
  content: 2000,
};

// ---------------------------------------------------------------------------
// Scopes

export type Scope =
  | { kind: "user"; user: string }
  | { kind: "server"; server: string }
  | { kind: "dm"; users: [string, string]; channel: string }
  | { kind: "saved"; user: string };

export function parseScope(scope: string): Scope | null {
  const parts = scope.split(":");
  switch (parts[0]) {
    case "user":
      return parts.length === 2 && isUlid(parts[1]) ? { kind: "user", user: parts[1] } : null;
    case "server":
      return parts.length === 2 && isUlid(parts[1]) ? { kind: "server", server: parts[1] } : null;
    case "saved":
      return parts.length === 2 && isUlid(parts[1]) ? { kind: "saved", user: parts[1] } : null;
    case "dm": {
      const [, a, b] = parts;
      if (parts.length !== 3 || !isUlid(a) || !isUlid(b) || !(a < b)) return null;
      return { kind: "dm", users: [a, b], channel: dmChannelId(a, b) };
    }
    default:
      return null;
  }
}

export const userScope = (user: string) => `user:${user}`;
export const serverScope = (server: string) => `server:${server}`;
export const savedScope = (user: string) => `saved:${user}`;

export function dmScope(a: string, b: string): string {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

/** Direct message channel ids are derived from the pair so both sides agree. */
export function dmChannelId(a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return ulidFrom(Math.max(decodeTime(x), decodeTime(y)), sha256(`stoat-p2p/dm/${x}:${y}`));
}

/** Saved Messages channel id of a user. */
export function savedChannelId(user: string): string {
  return ulidFrom(decodeTime(user), sha256(`stoat-p2p/saved/${user}`));
}

// ---------------------------------------------------------------------------
// Self-certifying identifiers

/** A user id is a ULID whose random part is a hash of the user's public key. */
export function userIdFromKey(pub: string, createdAt: number): string {
  return ulidFrom(createdAt, sha256(`stoat-p2p/user/${pub}`));
}

export function keyMatchesUser(pub: string, user: string): boolean {
  return isUlid(user) && randomPart(user) === encodeRandom(sha256(`stoat-p2p/user/${pub}`));
}

/** Server ids are bound to the owner's key and a nonce from the genesis event. */
export function serverIdFrom(ts: number, pub: string, nonce: string): string {
  return ulidFrom(ts, sha256(`stoat-p2p/server/${pub}/${nonce}`));
}

/** Id of the object (message, channel, role, ...) created by an event. */
export function objectId(event: Pick<StoatEvent, "id" | "ts">): string {
  return ulidFrom(event.ts, Buffer.from(event.id.slice(0, 20), "hex"));
}

const INVITE_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Invite codes are derived from the id of the `invite.create` event. */
export function inviteCode(event: Pick<StoatEvent, "id">): string {
  const bytes = Buffer.from(event.id, "hex");
  let out = "";
  for (let i = 0; i < 10; i++) out += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length];
  return out;
}

/** Four digit discriminator derived from the public key ("#1234"). */
export function discriminatorFor(pub: string): string {
  const value = sha256(`stoat-p2p/discriminator/${pub}`).readUInt32BE(0) % 9999;
  return String(value + 1).padStart(4, "0");
}

// ---------------------------------------------------------------------------
// Creation and verification

export interface Signer {
  user: string;
  keys: KeyPair;
}

export function eventId(unsigned: UnsignedEvent): string {
  return sha256hex(canonical(unsigned));
}

export function createEvent(
  signer: Signer,
  scope: string,
  type: string,
  body: Record<string, unknown>,
  deps: string[] = [],
  ts = Date.now(),
): StoatEvent {
  const unsigned: UnsignedEvent = {
    v: 1,
    scope,
    type,
    author: signer.user,
    key: signer.keys.pub,
    ts,
    deps: [...new Set(deps)].sort(),
    body: JSON.parse(canonical(body)),
  };
  const id = eventId(unsigned);
  return { ...unsigned, id, sig: signData(signer.keys, Buffer.from(id, "hex")) };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Structural and cryptographic validation. Returns an error string or null. */
export function verifyEvent(event: unknown, now = Date.now()): string | null {
  if (typeof event !== "object" || event === null) return "not an object";
  const e = event as Partial<StoatEvent>;
  if (e.v !== 1) return "unsupported version";
  if (typeof e.id !== "string" || !HEX64.test(e.id)) return "bad id";
  if (typeof e.scope !== "string" || !parseScope(e.scope)) return "bad scope";
  if (typeof e.type !== "string" || e.type.length > 64) return "bad type";
  if (!isUlid(e.author)) return "bad author";
  if (typeof e.key !== "string" || e.key.length !== 43) return "bad key";
  if (typeof e.ts !== "number" || !Number.isInteger(e.ts) || e.ts < 1_500_000_000_000) return "bad ts";
  if (e.ts > now + LIMITS.futureSkewMs) return "timestamp in the future";
  if (!Array.isArray(e.deps) || e.deps.length > LIMITS.deps) return "bad deps";
  for (let i = 0; i < e.deps.length; i++) {
    if (typeof e.deps[i] !== "string" || !HEX64.test(e.deps[i]!)) return "bad dep";
    if (i > 0 && !(e.deps[i - 1]! < e.deps[i]!)) return "deps not sorted";
  }
  if (typeof e.body !== "object" || e.body === null || Array.isArray(e.body)) return "bad body";
  if (typeof e.sig !== "string") return "bad signature";
  const keys = Object.keys(e).sort().join(",");
  if (keys !== "author,body,deps,id,key,scope,sig,ts,type,v") return "unexpected fields";

  let bodyText: string;
  try {
    bodyText = canonical(e.body);
  } catch {
    return "body not canonicalisable";
  }
  if (Buffer.byteLength(bodyText) > LIMITS.bodyBytes) return "body too large";

  const { id, sig, ...unsigned } = e as StoatEvent;
  if (eventId(unsigned) !== id) return "id mismatch";
  if (!keyMatchesUser(e.key, e.author)) return "key does not match author";
  if (!verifyData(e.key, Buffer.from(id, "hex"), sig)) return "bad signature";
  return null;
}

/** Day bucket used by the set reconciliation protocol. */
export function bucketOf(ts: number): number {
  return Math.floor(ts / 86_400_000);
}
