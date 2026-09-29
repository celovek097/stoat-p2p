// A stoat-p2p node: Stoat-compatible API for local clients on one side,
// peer-to-peer replication of signed events on the other.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { Accounts, type Account } from "./api/accounts.ts";
import { Bonfire } from "./api/events.ts";
import { FileStore } from "./api/files.ts";
import { ApiError, CORS_HEADERS, errors, readBody, requestOrigin, Router, sendJson } from "./api/http.ts";
import { registerAuth } from "./api/routes/auth.ts";
import { registerChannels } from "./api/routes/channels.ts";
import { registerInvites } from "./api/routes/invites.ts";
import { registerServers } from "./api/routes/servers.ts";
import { registerUsers } from "./api/routes/users.ts";
import { Serializer } from "./api/serialize.ts";
import { WebServer } from "./api/web.ts";
import { canonical, generateSigningKey, type KeyPair, open, seal, sharedSecret, type Sealed } from "./core/crypto.ts";
import {
  CONTENT_TYPES,
  createEvent,
  objectId,
  parseScope,
  SERVER_STATE_TYPES,
  savedChannelId,
  type Signer,
  type StoatEvent,
  userScope,
} from "./core/event.ts";
import { EventStore } from "./core/store.ts";
import { PeerManager } from "./p2p/manager.ts";
import { Permission } from "./state/permissions.ts";
import { applyStateEvent } from "./state/server.ts";
import type { FileObject, MessageData } from "./state/types.ts";
import { type ChannelRef, World, type WorldChange } from "./state/world.ts";

export interface NodeOptions {
  /** Directory for the event log, accounts and files; null keeps everything in memory. */
  dataDir: string | null;
  port: number;
  host: string;
  /** Peers to connect to on start, e.g. ws://example.org:14702/p2p */
  peers: string[];
  /** Public addresses of this node that other peers can dial */
  announce: string[];
  /** Discover other nodes on the local network */
  lan: boolean;
  /** Store and forward every scope for connected peers (for always-on hubs) */
  relay: boolean;
  /** Directory with the built Stoat web client */
  webDir: string | null;
  /** Allow new local accounts */
  registration: boolean;
  /** Trust X-Forwarded-* headers from a reverse proxy */
  trustProxy: boolean;
  /** Human readable node name shown to peers */
  name: string;
  log: (level: "info" | "debug" | "warn", message: string) => void;
}

export const DEFAULT_OPTIONS: NodeOptions = {
  dataDir: null,
  port: 14702,
  host: "0.0.0.0",
  peers: [],
  announce: [],
  lan: false,
  relay: false,
  webDir: null,
  registration: true,
  trustProxy: false,
  name: "stoat-p2p node",
  log: () => {},
};

class Presence {
  readonly #node: StoatNode;
  readonly #remote = new Map<string, Map<string, number>>();

  constructor(node: StoatNode) {
    this.#node = node;
  }

  isOnline(user: string): boolean {
    for (const connection of this.#node.bonfire.connections) if (connection.account.id === user) return true;
    const remote = this.#remote.get(user);
    if (!remote) return false;
    const now = Date.now();
    for (const [peer, expires] of remote) {
      if (expires > now) return true;
      remote.delete(peer);
    }
    return false;
  }

  /** A local user connected or disconnected. */
  changed(user: string): void {
    const online = this.isOnline(user);
    this.#node.bonfire.broadcast({ type: "UserUpdate", id: user, data: { online } });
    this.#node.p2p.announcePresence();
  }

  /** Presence reported by a peer for the users it hosts. */
  remote(peer: string, users: string[]): void {
    const expires = Date.now() + 90_000;
    const reported = new Set(users);
    for (const [user, peers] of this.#remote) {
      if (peers.has(peer) && !reported.has(user)) {
        peers.delete(peer);
        if (!this.isOnline(user)) this.#node.bonfire.broadcast({ type: "UserUpdate", id: user, data: { online: false } });
      }
    }
    for (const user of users) {
      const wasOnline = this.isOnline(user);
      let peers = this.#remote.get(user);
      if (!peers) this.#remote.set(user, (peers = new Map()));
      peers.set(peer, expires);
      if (!wasOnline) this.#node.bonfire.broadcast({ type: "UserUpdate", id: user, data: { online: true } });
    }
  }

  peerGone(peer: string): void {
    this.remote(peer, []);
  }
}

export class StoatNode extends EventEmitter {
  readonly options: NodeOptions;
  readonly store: EventStore;
  readonly world: World;
  readonly accounts: Accounts;
  readonly files: FileStore;
  readonly serializer: Serializer;
  readonly presence: Presence;
  readonly bonfire: Bonfire;
  readonly p2p: PeerManager;
  readonly web: WebServer;
  readonly key: KeyPair;
  readonly router = new Router();
  readonly http: http.Server;
  /** File objects seen in events, so files fetched from peers keep their name and type */
  readonly #fileMeta = new Map<string, FileObject>();
  readonly #sockets = new Set<import("node:net").Socket>();
  #stopped = false;

  constructor(options: Partial<NodeOptions> = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const dir = this.options.dataDir;
    if (dir) mkdirSync(dir, { recursive: true });
    this.key = loadNodeKey(dir);
    this.store = new EventStore(dir);
    this.world = new World(this.store);
    this.world.decryptor = (event) => this.#decrypt(event);
    this.accounts = new Accounts(dir);
    this.files = new FileStore(dir);
    this.serializer = new Serializer({ world: this.world, isOnline: (user) => this.presence.isOnline(user) });
    this.presence = new Presence(this);
    this.bonfire = new Bonfire(this);
    this.p2p = new PeerManager(this);
    this.web = new WebServer(this);

    registerAuth(this.router, this);
    registerUsers(this.router, this);
    registerServers(this.router, this);
    registerChannels(this.router, this);
    registerInvites(this.router, this);

    this.world.on("change", (change: WorldChange) => {
      this.#trackMentions(change);
      if (change.type === "profile" && this.accounts.get(change.user)?.imported && this.http.listening) {
        setImmediate(() => this.#refreshProfiles());
      }
      if (change.type === "message.create") for (const file of change.message.attachments ?? []) this.#fileMeta.set(file._id, file);
    });
    this.world.on("accepted", (event: StoatEvent) => this.#indexFiles(event.body, 0));

    this.http = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.options.log("warn", `request failed: ${error?.stack ?? error}`);
        sendJson(res, 500, { type: "InternalError" });
      });
    });
    this.http.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
    this.http.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/events" || path === "/api/events") this.bonfire.handleUpgrade(req, socket, head);
      else if (path === "/p2p") this.p2p.handleUpgrade(req, socket, head);
      else socket.destroy();
    });
  }

  get log() {
    return this.options.log;
  }

  /** Node id shown to peers and on the dashboard. */
  get nodeId(): string {
    return this.key.pub;
  }

  get port(): number {
    return (this.http.address() as AddressInfo | null)?.port ?? this.options.port;
  }

  async start(): Promise<void> {
    const count = this.world.load();
    this.log("info", `loaded ${count} events from disk`);
    for (const account of this.accounts.list()) {
      const saved = savedChannelId(account.id);
      this.world.channels.set(saved, { kind: "saved", user: account.id, channel: saved });
    }
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port, this.options.host, () => resolve());
    });
    this.log("info", `listening on http://${this.options.host}:${this.port}`);
    this.#refreshProfiles();
    this.p2p.start();
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.p2p.stop();
    this.bonfire.close();
    this.accounts.flush();
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
      for (const socket of this.#sockets) socket.destroy();
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const origin = requestOrigin(req, this.options.trustProxy);

    if (path === "/api" || path.startsWith("/api/")) {
      for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      await this.#handleApi(req, res, path.slice(4) || "/", url.searchParams, origin);
      return;
    }
    if (path.startsWith("/autumn/")) {
      await this.web.handleFiles(req, res, path.slice("/autumn".length));
      return;
    }
    await this.web.handle(req, res, url, origin);
  }

  async #handleApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, origin: string): Promise<void> {
    const match = this.router.match(req.method ?? "GET", path);
    if (!match) {
      sendJson(res, 404, { type: "NotFound" });
      return;
    }
    try {
      let body: unknown;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const raw = await readBody(req);
        if (raw.length) {
          try {
            body = JSON.parse(raw.toString("utf8"));
          } catch {
            throw errors.validation("invalid JSON body");
          }
        }
      }
      const auth = this.accounts.byToken(req.headers["x-session-token"] as string | undefined);
      if (match.route.auth) {
        if (!auth) throw req.headers["x-session-token"] ? errors.invalidSession() : errors.notAuthenticated();
        auth.session.lastSeen = Date.now();
        if (!auth.account.onboarded && !path.startsWith("/onboard") && !path.startsWith("/auth") && !path.startsWith("/sync")) {
          throw new ApiError(403, "OnboardingNotFinished");
        }
      }
      const result = await match.route.handler({
        req,
        res,
        params: match.params,
        query,
        body,
        account: auth?.account as Account,
        session: auth?.session as never,
        origin,
      });
      if (!res.headersSent) sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof ApiError) sendJson(res, error.status, error.body);
      else throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Publishing

  signer(account: Account): Signer {
    return { user: account.id, keys: account.keys };
  }

  /**
   * Sign and ingest a new event authored by a local account.
   * Server state events are dry-run first so the client gets an error
   * instead of an event that every node would ignore.
   */
  publish(
    account: Account,
    scope: string,
    type: string,
    body: Record<string, unknown>,
    extraDeps: string[] = [],
    ts?: number,
    failure?: string,
  ): StoatEvent {
    const parsed = parseScope(scope);
    if (!parsed) throw errors.invalidOperation();
    const deps = [...extraDeps];
    if (parsed.kind === "server" && type !== "server.create") deps.push(...this.world.heads(scope));
    let payload = body;
    if (parsed.kind === "dm" && CONTENT_TYPES.has(type)) payload = this.#encrypt(account, scope, parsed.users, body) ?? body;
    const event = createEvent(this.signer(account), scope, type, payload, deps, ts);

    if (parsed.kind === "server" && SERVER_STATE_TYPES.has(type)) {
      const state = this.world.servers.get(parsed.server);
      const snap = state ? structuredClone(state.snap) : undefined;
      if (type !== "server.create" && (!state || !snap)) throw errors.unknownServer();
      if (snap && !applyStateEvent(snap, event, state!.size, parsed.server)) {
        if (failure && failure in Permission) throw errors.missingPermission(failure);
        throw new ApiError(failure ? 403 : 400, failure ?? "InvalidOperation");
      }
    }
    const result = this.world.ingest(event, { source: "local" });
    if (result.status !== "accepted") {
      this.log("warn", `local event rejected: ${result.reason}`);
      throw new ApiError(400, "InvalidOperation", { reason: result.reason });
    }
    return event;
  }

  messageForEvent(channel: string, event: StoatEvent): MessageData | undefined {
    return this.world.message(channel, objectId(event));
  }

  /** Publish the full profile of a local user, merged with `changes`. */
  publishProfile(account: Account, changes: Record<string, unknown>): StoatEvent {
    const current = this.world.profiles.get(account.id);
    const body: Record<string, unknown> = {
      username: current?.username,
      display_name: current?.display_name,
      avatar: current?.avatar,
      status: current?.status,
      profile: current?.profile,
      pronouns: current?.pronouns,
      ...changes,
      x25519: account.x25519.pub,
      nodes: this.p2p.publicAddresses(),
    };
    if (!body.username) body.username = `user${account.id.slice(-4).toLowerCase()}`;
    const event = this.publish(account, userScope(account.id), "user.profile", JSON.parse(canonical(body)));
    this.p2p.profilesChanged();
    return event;
  }

  /** Keep our users' profiles pointing at this node (addresses, encryption key). */
  #refreshProfiles(): void {
    const addresses = JSON.stringify(this.p2p.publicAddresses());
    for (const account of this.accounts.list()) {
      if (!account.onboarded) continue;
      const profile = this.world.profiles.get(account.id);
      // An identity imported from another node gets its profile from the network first.
      if (!profile && account.imported) continue;
      if (!profile || JSON.stringify(profile.nodes ?? []) !== addresses || profile.x25519 !== account.x25519.pub) {
        this.publishProfile(account, {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // End-to-end encrypted direct messages

  #encrypt(account: Account, scope: string, users: [string, string], body: Record<string, unknown>): Record<string, unknown> | null {
    const other = users[0] === account.id ? users[1] : users[0];
    const theirs = this.world.profiles.get(other)?.x25519;
    if (!theirs) return null;
    const key = sharedSecret(account.x25519, theirs, `stoat-p2p/dm/v1/${scope}`);
    return { enc: { ...seal(key, canonical(body), scope), k: account.x25519.pub, r: theirs } };
  }

  #decrypt(event: StoatEvent): Record<string, unknown> | null {
    const parsed = parseScope(event.scope);
    const enc = event.body.enc as (Sealed & { k: string; r: string }) | undefined;
    if (parsed?.kind !== "dm" || !enc) return null;
    for (const user of parsed.users) {
      const account = this.accounts.get(user);
      if (!account) continue;
      const other = account.id === event.author ? enc.r : enc.k;
      if (typeof other !== "string") continue;
      const plain = open(sharedSecret(account.x25519, other, `stoat-p2p/dm/v1/${event.scope}`), enc, event.scope);
      if (plain) {
        try {
          return JSON.parse(plain);
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Helpers used by the API

  dmChannelsOf(user: string): Array<Extract<ChannelRef, { kind: "dm" }>> {
    const open = new Set(this.accounts.openDms(user));
    return this.world
      .dmsOf(user)
      .filter((dm) => open.has(dm.channel) || this.world.lastMessageId(dm.channel))
      .map((dm) => ({ kind: "dm", scope: dm.scope, channel: dm.channel, users: dm.users }));
  }

  typing(user: string, channel: string, on: boolean, fromPeer = false): void {
    const ref = this.world.channel(channel);
    if (!ref) return;
    const event = { type: on ? "ChannelStartTyping" : "ChannelStopTyping", id: channel, user };
    for (const connection of this.bonfire.connections) {
      if (connection.account.id === user) continue;
      if (ref.kind === "server" && !connection.servers.has(ref.server)) continue;
      if (ref.kind === "dm" && !ref.users.includes(connection.account.id)) continue;
      if (ref.kind === "saved") continue;
      connection.ws.send(JSON.stringify(event));
    }
    if (!fromPeer && ref.kind !== "saved") this.p2p.sendTyping(user, channel, on);
  }

  async lookupInvite(code: string): Promise<void> {
    await this.p2p.lookupInvite(code);
  }

  async lookupUser(user: string): Promise<void> {
    await this.p2p.fetchScope(userScope(user), 3000);
  }

  #indexFiles(value: unknown, depth: number): void {
    if (depth > 4 || typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record._id === "string" && typeof record.tag === "string" && typeof record.content_type === "string") {
      this.#fileMeta.set(record._id, record as unknown as FileObject);
      return;
    }
    for (const child of Object.values(record)) this.#indexFiles(child, depth + 1);
  }

  findFileMeta(hash: string): FileObject | undefined {
    return this.#fileMeta.get(hash) ?? this.files.meta(hash);
  }

  #trackMentions(change: WorldChange): void {
    if (change.type !== "message.create") return;
    const message = change.message;
    const ref = this.world.channel(message.channel);
    for (const account of this.accounts.list()) {
      if (account.id === message.author) continue;
      let mentioned = message.mentions?.includes(account.id) ?? false;
      if (!mentioned && ref?.kind === "server" && message.role_mentions?.length) {
        const member = this.world.server(ref.server)?.snap.members[account.id];
        mentioned = !!member?.roles.some((role) => message.role_mentions!.includes(role));
      }
      if (!mentioned && ref?.kind === "dm" && ref.users.includes(account.id)) mentioned = true;
      if (mentioned) this.accounts.mention(account.id, message.channel, message.id);
    }
  }
}

function loadNodeKey(dir: string | null): KeyPair {
  if (!dir) return generateSigningKey();
  const file = join(dir, "node.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).key;
  const key = generateSigningKey();
  writeFileSync(file, JSON.stringify({ key }, null, 1), { mode: 0o600 });
  return key;
}
