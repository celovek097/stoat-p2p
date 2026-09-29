import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  scryptSync,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

export function b64u(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64url");
}

export function fromB64u(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

export function sha256hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped.
 * Signatures and event ids are computed over this representation.
 */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`cannot canonicalise ${typeof value}`);
  }
}

// ---------------------------------------------------------------------------
// Ed25519 signing keys (public and private halves are raw 32-byte base64url)

export interface KeyPair {
  /** base64url raw public key */
  pub: string;
  /** base64url raw private key (seed) */
  priv: string;
}

export function generateSigningKey(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  void publicKey;
  return { pub: jwk.x!, priv: jwk.d! };
}

const publicKeys = new Map<string, KeyObject>();
const privateKeys = new Map<string, KeyObject>();

function publicKeyObject(pub: string, crv: "Ed25519" | "X25519" = "Ed25519"): KeyObject {
  const cacheKey = `${crv}:${pub}`;
  let key = publicKeys.get(cacheKey);
  if (!key) {
    key = createPublicKey({ key: { kty: "OKP", crv, x: pub }, format: "jwk" });
    if (publicKeys.size > 10_000) publicKeys.clear();
    publicKeys.set(cacheKey, key);
  }
  return key;
}

function privateKeyObject(pair: KeyPair, crv: "Ed25519" | "X25519" = "Ed25519"): KeyObject {
  const cacheKey = `${crv}:${pair.pub}`;
  let key = privateKeys.get(cacheKey);
  if (!key) {
    key = createPrivateKey({ key: { kty: "OKP", crv, x: pair.pub, d: pair.priv }, format: "jwk" });
    privateKeys.set(cacheKey, key);
  }
  return key;
}

export function signData(pair: KeyPair, data: string | Uint8Array): string {
  return b64u(sign(null, typeof data === "string" ? Buffer.from(data) : data, privateKeyObject(pair)));
}

export function verifyData(pub: string, data: string | Uint8Array, signature: string): boolean {
  try {
    if (fromB64u(pub).length !== 32) return false;
    const sig = fromB64u(signature);
    if (sig.length !== 64) return false;
    return verify(null, typeof data === "string" ? Buffer.from(data) : data, publicKeyObject(pub), sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// X25519 keys used for end-to-end encrypted direct messages

export function generateAgreementKey(): KeyPair {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { pub: jwk.x!, priv: jwk.d! };
}

export function sharedSecret(own: KeyPair, theirPub: string, info: string): Buffer {
  const secret = diffieHellman({
    privateKey: privateKeyObject(own, "X25519"),
    publicKey: publicKeyObject(theirPub, "X25519"),
  });
  return Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from(info), 32));
}

export interface Sealed {
  n: string;
  c: string;
}

export function seal(key: Buffer, plaintext: string, aad: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad), { plaintextLength: Buffer.byteLength(plaintext) });
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { n: b64u(nonce), c: b64u(body) };
}

export function open(key: Buffer, sealed: Sealed, aad: string): string | null {
  try {
    const data = fromB64u(sealed.c);
    const decipher = createDecipheriv("chacha20-poly1305", key, fromB64u(sealed.n), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad), { plaintextLength: data.length - 16 });
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local account passwords

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${b64u(salt)}$${b64u(hash)}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = fromB64u(hash);
  const actual = scryptSync(password, fromB64u(salt), expected.length);
  return timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32): string {
  return b64u(randomBytes(bytes));
}
