// Serves the official Stoat web client (built with placeholder URLs that are
// replaced per request host), the Autumn file endpoints and the node
// dashboard at /node.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, relative, sep } from "node:path";

import { isUlid } from "../core/ulid.ts";
import type { StoatNode } from "../node.ts";
import { dashboardPage, landingPage } from "./dashboard.ts";
import { ApiError, readBody, sendJson } from "./http.ts";
import { TAG_LIMITS } from "./files.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

const PLACEHOLDERS = [
  "__VITE_HOST__",
  "__VITE_API_URL__",
  "__VITE_WS_URL__",
  "__VITE_MEDIA_URL__",
  "__VITE_PROXY_URL__",
  "__VITE_GIFBOX_URL__",
  "__VITE_RNNOISE_WORKLET_CDN_URL__",
];

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp)|video\/|audio\/)/;

export class WebServer {
  readonly #node: StoatNode;
  #templated = new Set<string>();
  readonly #cache = new Map<string, Buffer>();
  #scanned = false;

  constructor(node: StoatNode) {
    this.#node = node;
  }

  get #dir(): string | null {
    const dir = this.#node.options.webDir;
    return dir && existsSync(join(dir, "index.html")) ? dir : null;
  }

  #scan(dir: string): void {
    if (this.#scanned) return;
    this.#scanned = true;
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(m?js|html)$/.test(entry.name)) {
          const text = readFileSync(path, "latin1");
          if (PLACEHOLDERS.some((p) => text.includes(p))) this.#templated.add(relative(dir, path));
        }
      }
    };
    walk(dir);
  }

  #inject(dir: string, file: string, host: string, origin: string): Buffer {
    const key = `${host}\n${file}`;
    let data = this.#cache.get(key);
    if (!data) {
      let text = readFileSync(join(dir, file), "utf8");
      const values: Record<string, string | undefined> = {
        __VITE_HOST__: host,
        __VITE_API_URL__: `${origin}/api`,
      };
      for (const placeholder of PLACEHOLDERS) {
        const value = values[placeholder];
        text = value ? text.replaceAll(placeholder, value) : text.replaceAll(`"${placeholder}"`, "void 0");
      }
      data = Buffer.from(text, "utf8");
      if (this.#cache.size > 200) this.#cache.clear();
      this.#cache.set(key, data);
    }
    return data;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, origin: string): Promise<void> {
    const path = url.pathname;
    if (path === "/node" || path.startsWith("/node/")) {
      await this.#dashboard(req, res, url, origin);
      return;
    }
    const dir = this.#dir;
    if (!dir) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(landingPage(this.#node, origin));
      return;
    }
    this.#scan(dir);

    let file = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
    const full = join(dir, file);
    if (!full.startsWith(dir + sep) && full !== dir) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!file || !existsSync(full) || statSync(full).isDirectory()) file = "index.html"; // SPA fallback

    const host = new URL(origin).host;
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type };
    if (file === "index.html" || file.endsWith("serviceWorker.js")) headers["Cache-Control"] = "no-cache";
    else if (file.startsWith(`assets${sep}`)) headers["Cache-Control"] = "public, max-age=31536000, immutable";

    if (this.#templated.has(file)) {
      const data = this.#inject(dir, file, host, origin);
      res.writeHead(200, { ...headers, "Content-Length": data.length });
      res.end(data);
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": statSync(join(dir, file)).size });
    createReadStream(join(dir, file)).pipe(res);
  }

  // Autumn ------------------------------------------------------------------------

  async handleFiles(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Token");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const parts = path.split("/").filter(Boolean);
    try {
      if (req.method === "POST" && parts.length === 1) {
        sendJson(res, 200, await this.#upload(req, parts[0]!));
        return;
      }
      if (req.method === "GET" && parts.length >= 2) {
        await this.#download(res, parts[0]!, parts[1]!, parts[2] === "original");
        return;
      }
      if (req.method === "GET" && parts.length === 0) {
        sendJson(res, 200, { autumn: "stoat-p2p", tags: TAG_LIMITS });
        return;
      }
      sendJson(res, 404, { type: "NotFound" });
    } catch (error) {
      if (error instanceof ApiError) sendJson(res, error.status, error.body);
      else throw error;
    }
  }

  async #upload(req: IncomingMessage, tag: string): Promise<{ id: string }> {
    const auth = this.#node.accounts.byToken(req.headers["x-session-token"] as string | undefined);
    if (!auth) throw new ApiError(401, "NotAuthenticated");
    const limit = TAG_LIMITS[tag];
    if (!limit) throw new ApiError(404, "NotFound");
    const raw = await readBody(req, limit + 64 * 1024);
    const form = await new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": String(req.headers["content-type"] ?? "") },
      body: raw,
    })
      .formData()
      .catch(() => {
        throw new ApiError(400, "MissingHeaders");
      });
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ApiError(400, "MissingHeaders");
    const data = Buffer.from(await file.arrayBuffer());
    if (data.length === 0) throw new ApiError(400, "FileTooSmall");
    try {
      return { id: this.#node.files.put(data, tag, file.name || "file", file.type || "application/octet-stream")._id };
    } catch (error) {
      const message = String((error as Error).message);
      if (message.includes("too large")) throw new ApiError(400, "FileTooLarge", { max: limit });
      if (message.includes("type")) throw new ApiError(400, "FileTypeNotAllowed");
      throw error;
    }
  }

  async #download(res: ServerResponse, tag: string, id: string, original: boolean): Promise<void> {
    let hash = id;
    let meta = this.#node.files.meta(id);
    if (tag === "emojis" && isUlid(id)) {
      for (const state of this.#node.world.servers.values()) {
        const emoji = state.snap.emojis[id];
        if (emoji) {
          hash = emoji.file._id;
          meta = emoji.file;
        }
      }
    }
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError(404, "NotFound");
    let data = this.#node.files.get(hash);
    if (!data) data = await this.#node.p2p.fetchFile(hash);
    if (!data) throw new ApiError(404, "NotFound");
    meta ??= this.#node.findFileMeta(hash);
    const type = meta?.content_type ?? "application/octet-stream";
    const inline = INLINE_TYPES.test(type);
    const filename = (meta?.filename ?? hash).replace(/["\r\n]/g, "_");
    res.writeHead(200, {
      "Content-Type": inline ? type : "application/octet-stream",
      "Content-Length": data.length,
      "Content-Disposition": `${inline && !original ? "inline" : "attachment"}; filename="${filename}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.end(data);
  }

  // Dashboard -----------------------------------------------------------------------

  #isLocal(req: IncomingMessage): boolean {
    const address = req.socket.remoteAddress ?? "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  async #dashboard(req: IncomingMessage, res: ServerResponse, url: URL, origin: string): Promise<void> {
    const node = this.#node;
    if (url.pathname === "/node/api/status") {
      sendJson(res, 200, node.p2p.status());
      return;
    }
    if (url.pathname === "/node/api/peers" && req.method === "POST") {
      if (!this.#isLocal(req)) {
        sendJson(res, 403, { type: "NotPrivileged" });
        return;
      }
      let body: { url?: unknown };
      try {
        body = JSON.parse((await readBody(req, 4096)).toString("utf8"));
      } catch {
        body = {};
      }
      if (typeof body.url !== "string" || !/^wss?:\/\/[^\s]+$/.test(body.url)) {
        sendJson(res, 400, { type: "FailedValidation", error: "url" });
        return;
      }
      node.p2p.addPeer(body.url, true);
      sendJson(res, 200, { ok: true });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(dashboardPage(node, origin, this.#isLocal(req)));
  }
}
