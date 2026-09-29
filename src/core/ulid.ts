// ULID helpers (https://github.com/ulid/spec).
//
// Stoat identifies every object with a ULID and the clients decode the
// timestamp part to display creation times. In stoat-p2p the 80 random bits
// are replaced with bits of a hash, which makes identifiers self-certifying:
// an id can be recomputed from the key or the event that created the object.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TIME = 2 ** 48 - 1;

export function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`invalid ULID time: ${ms}`);
  }
  let out = "";
  let value = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/** Encode exactly 10 bytes (80 bits) as 16 Crockford base32 characters. */
export function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length < 10) throw new RangeError("need 10 bytes of randomness");
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < 10; i++) {
    buffer = (buffer << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

export function ulidFrom(ms: number, bytes: Uint8Array): string {
  return encodeTime(ms) + encodeRandom(bytes);
}

export function decodeTime(id: string): number {
  let value = 0;
  for (let i = 0; i < 10; i++) {
    const index = ALPHABET.indexOf(id[i]!);
    if (index < 0) throw new RangeError(`invalid ULID: ${id}`);
    value = value * 32 + index;
  }
  return value;
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}

/** Random part of a ULID (last 16 characters). */
export function randomPart(id: string): string {
  return id.slice(10);
}

export function randomUlid(ms = Date.now()): string {
  return ulidFrom(ms, crypto.getRandomValues(new Uint8Array(10)));
}

/** The all-zero id Stoat uses as the author of system messages. */
export const SYSTEM_USER_ID = "00000000000000000000000000";
