import type { IncomingMessage, ServerResponse } from "node:http";

import type { Account, Session } from "./accounts.ts";

/** An error in the Stoat API format: `{ "type": "...", ... }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, type: string, extra: Record<string, unknown> = {}) {
    super(type);
    this.status = status;
    this.body = { type, ...extra };
  }
}

export const errors = {
  notFound: () => new ApiError(404, "NotFound"),
  unknownUser: () => new ApiError(404, "UnknownUser"),
  unknownServer: () => new ApiError(404, "UnknownServer"),
  unknownChannel: () => new ApiError(404, "UnknownChannel"),
  unknownMessage: () => new ApiError(404, "UnknownMessage"),
  invalidSession: () => new ApiError(401, "InvalidSession"),
  notAuthenticated: () => new ApiError(401, "NotAuthenticated"),
  invalidCredentials: () => new ApiError(401, "InvalidCredentials"),
  missingPermission: (permission: string) => new ApiError(403, "MissingPermission", { permission }),
  notOwner: () => new ApiError(403, "NotOwner"),
  invalidOperation: () => new ApiError(400, "InvalidOperation"),
  validation: (error: string) => new ApiError(400, "FailedValidation", { error }),
  featureDisabled: (feature: string) => new ApiError(400, "FeatureDisabled", { feature }),
};

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  account: Account;
  session: Session;
  origin: string;
}

type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  auth: boolean;
}

export class Router {
  readonly #routes: Route[] = [];

  #add(method: string, path: string, handler: Handler, auth: boolean): void {
    this.#routes.push({ method, parts: path.split("/").filter(Boolean), handler, auth });
  }

  get(path: string, handler: Handler, auth = true): void {
    this.#add("GET", path, handler, auth);
  }
  post(path: string, handler: Handler, auth = true): void {
    this.#add("POST", path, handler, auth);
  }
  put(path: string, handler: Handler, auth = true): void {
    this.#add("PUT", path, handler, auth);
  }
  patch(path: string, handler: Handler, auth = true): void {
    this.#add("PATCH", path, handler, auth);
  }
  delete(path: string, handler: Handler, auth = true): void {
    this.#add("DELETE", path, handler, auth);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    let fallback: { route: Route; params: Record<string, string> } | undefined;
    for (const route of this.#routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      let literal = 0;
      for (let i = 0; i < parts.length; i++) {
        const want = route.parts[i]!;
        if (want.startsWith(":")) params[want.slice(1)] = parts[i]!;
        else if (want === parts[i]) literal++;
        else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      // Prefer the most specific route (e.g. /users/@me over /users/:id).
      if (!fallback || literal > fallback.route.parts.filter((p) => !p.startsWith(":")).length) {
        fallback = { route, params };
      }
    }
    return fallback;
  }
}

export async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, "PayloadTooLarge");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(204);
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Session-Token, X-Bot-Token, X-MFA-Ticket, Idempotency-Key",
  "Access-Control-Max-Age": "86400",
};

/** Public origin of the request (honours reverse proxies). */
export function requestOrigin(req: IncomingMessage, trustProxy: boolean): string {
  const forwardedProto = trustProxy ? String(req.headers["x-forwarded-proto"] ?? "").split(",")[0] : "";
  const forwardedHost = trustProxy ? String(req.headers["x-forwarded-host"] ?? "").split(",")[0] : "";
  const proto = forwardedProto || ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const host = forwardedHost || req.headers.host || "localhost";
  return `${proto}://${host}`;
}
