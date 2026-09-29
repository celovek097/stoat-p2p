// Content-addressed file storage compatible with Stoat's "Autumn" service.
// A file's id is the sha256 of its bytes, so a copy fetched from any peer
// can be verified before it is served.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256hex } from "../core/crypto.ts";
import type { FileObject } from "../state/types.ts";

export const TAG_LIMITS: Record<string, number> = {
  attachments: 20_000_000,
  avatars: 4_000_000,
  backgrounds: 6_000_000,
  icons: 2_500_000,
  banners: 6_000_000,
  emojis: 500_000,
};

const IMAGE_ONLY = new Set(["avatars", "backgrounds", "icons", "banners", "emojis"]);

export class FileStore {
  readonly #dir: string | null;
  readonly #memory = new Map<string, Buffer>();
  readonly #meta = new Map<string, FileObject>();

  constructor(dir: string | null) {
    this.#dir = dir ? join(dir, "files") : null;
    if (this.#dir) mkdirSync(this.#dir, { recursive: true });
  }

  has(hash: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(hash)) return false;
    return this.#memory.has(hash) || (!!this.#dir && existsSync(join(this.#dir, hash)));
  }

  get(hash: string): Buffer | undefined {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const cached = this.#memory.get(hash);
    if (cached) return cached;
    if (this.#dir && existsSync(join(this.#dir, hash))) return readFileSync(join(this.#dir, hash));
    return undefined;
  }

  /** Metadata of a file uploaded through this node. */
  meta(hash: string): FileObject | undefined {
    const cached = this.#meta.get(hash);
    if (cached) return cached;
    if (this.#dir && existsSync(join(this.#dir, `${hash}.json`))) {
      const meta = JSON.parse(readFileSync(join(this.#dir, `${hash}.json`), "utf8")) as FileObject;
      this.#meta.set(hash, meta);
      return meta;
    }
    return undefined;
  }

  #write(hash: string, data: Buffer): void {
    if (this.#dir) writeFileSync(join(this.#dir, hash), data);
    else this.#memory.set(hash, data);
  }

  /** Store an upload and describe it as a Stoat File object. */
  put(data: Buffer, tag: string, filename: string, contentType: string): FileObject {
    const limit = TAG_LIMITS[tag];
    if (!limit) throw new Error("unknown tag");
    if (data.length > limit) throw new Error("file too large");
    const hash = sha256hex(data);
    const metadata = sniffMetadata(data, contentType, filename);
    if (IMAGE_ONLY.has(tag) && metadata.type !== "Image") throw new Error("file type not allowed");
    const file: FileObject = {
      _id: hash,
      tag,
      filename: filename.slice(0, 128) || "file",
      metadata,
      content_type: metadata.type === "Image" ? imageMime(data) : contentType.slice(0, 128) || "application/octet-stream",
      size: data.length,
    };
    if (!this.has(hash)) this.#write(hash, data);
    this.#meta.set(hash, file);
    if (this.#dir) writeFileSync(join(this.#dir, `${hash}.json`), JSON.stringify(file));
    return file;
  }

  /** Store bytes received from a peer; rejected unless they hash to `hash`. */
  putVerified(hash: string, data: Buffer): boolean {
    if (sha256hex(data) !== hash) return false;
    if (!this.has(hash)) this.#write(hash, data);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Metadata sniffing

function imageMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return "application/octet-stream";
}

export function imageSize(data: Buffer): { width: number; height: number } | undefined {
  try {
    const mime = imageMime(data);
    if (mime === "image/png") return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (mime === "image/gif") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (mime === "image/webp") {
      const chunk = data.subarray(12, 16).toString("latin1");
      if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = data.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X") return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset < data.length) {
        if (data[offset] !== 0xff) return undefined;
        const marker = data[offset + 1]!;
        const length = data.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    // truncated or corrupt image
  }
  return undefined;
}

const TEXT_EXTENSIONS = /\.(txt|md|json|js|ts|py|rs|go|c|h|cpp|java|kt|toml|yaml|yml|csv|log|sh|css|xml|ini)$/i;

export function sniffMetadata(data: Buffer, contentType: string, filename: string): FileObject["metadata"] {
  const size = imageSize(data);
  if (size && size.width > 0 && size.height > 0) return { type: "Image", ...size };
  if (contentType.startsWith("audio/")) return { type: "Audio" };
  if (contentType.startsWith("text/") || TEXT_EXTENSIONS.test(filename)) return { type: "Text" };
  return { type: "File" };
}

/** Default avatar: a coloured circle with the user's initial. */
export function defaultAvatar(id: string, name: string): string {
  const hue = Number.parseInt(sha256hex(id).slice(0, 4), 16) % 360;
  const letter = (name.trim()[0] ?? "?").toUpperCase().replace(/[<>&"']/g, "?");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="hsl(${hue},55%,45%)"/><text x="128" y="128" dy=".35em" text-anchor="middle" font-family="sans-serif" font-size="128" fill="#fff">${letter}</text></svg>`;
}
