// Peer-to-peer replication.
//
// Nodes connect over WebSocket, authenticate, and then replicate "scopes"
// (a server, a direct-message pair, a user profile). A scope is served to a
// peer only if the peer hosts (or relays for) a user entitled to it, or
// presents a valid invite. New events are pushed live; after (re)connecting
// peers reconcile per-day buckets of event ids and pull what they miss.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { findInvite } from "../api/routes/invites.ts";
import { b64u, signData } from "../core/crypto.ts";
import { parseScope, type StoatEvent, serverScope } from "../core/event.ts";
import type { StoatNode } from "../node.ts";
import type { WorldChange } from "../state/world.ts";
import { LanDiscovery } from "./lan.ts";
import {
  type Auth,
  authMessage,
  type Delegation,
  delegate,
  type Frame,
  type Hello,
  Peer,
  PROTOCOL,
  proveUser,
} from "./peer.ts";

const MAX_PEERS = 32;
const EVENTS_PER_FRAME = 200;
const FILE_CHUNK = 512 * 1024;

export interface PeerStatus {
  id: string;
  name: string;
  url?: string;
  connected: boolean;
  relay: boolean;
  users: number;
  scopes: number;
}

interface KnownPeer {
  url: string;
  persistent: boolean;
  attempts: number;
  timer?: NodeJS.Timeout;
  peer?: Peer;
  node?: string;
}

interface FileRequest {
  hash: string;
  chunks: Map<string, Buffer[]>;
  resolve: (data: Buffer | undefined) => void;
  promise: Promise<Buffer | undefined>;
}

export class PeerManager {
  readonly #node: StoatNode;
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  readonly #peers = new Map<string, Peer>();
  readonly #known = new Map<string, KnownPeer>();
  #interest = new Set<string>();
  readonly #explicit = new Set<string>();
  /** Invite codes used to fetch scopes of servers we are about to join */
  readonly #inviteFor = new Map<string, string>();
  /** Delegations our peers' users granted to us (when we relay) */
  readonly #granted = new Map<string, Delegation>();
  /** Delegations we handed to relays, per relay node */
  readonly #grants = new Map<string, { at: number; list: Delegation[] }>();
  readonly #forwarded = new Map<string, Peer>();
  readonly #files = new Map<string, FileRequest>();
  readonly #timers: NodeJS.Timeout[] = [];
  #recomputeTimer: NodeJS.Timeout | undefined;
  #grantTimer: NodeJS.Timeout | undefined;
  #lan: LanDiscovery | undefined;
  #stopped = false;

  constructor(node: StoatNode) {
    this.#node = node;
  }

  get #world() {
    return this.#node.world;
  }

  get #log() {
    return this.#node.options.log;
  }

  // Lifecycle -------------------------------------------------------------------

  start(): void {
    const world = this.#world;
    world.on("accepted", (event: StoatEvent, source?: string) => this.#forward(event, source));
    world.on("missing", (ids: string[], source?: string) => this.#requestMissing(ids, source));
    world.on("change", (change: WorldChange) => {
      if (change.type === "server" || change.type === "dm" || change.type === "relation") this.#scheduleRecompute();
    });
    this.#recompute();

    for (const url of this.#loadKnown()) this.addPeer(url, true);
    for (const url of this.#node.options.peers) this.addPeer(url, true);

    this.#timers.push(
      setInterval(() => this.#keepalive(), 30_000),
      setInterval(() => this.#antiEntropy(), 5 * 60_000),
      setInterval(() => this.announcePresence(), 45_000),
    );
    if (this.#node.options.lan) {
      this.#lan = new LanDiscovery(this.#node.nodeId, this.#node.port, (url) => this.addPeer(url, false), this.#log);
      this.#lan.start();
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearInterval(timer);
    clearTimeout(this.#recomputeTimer);
    clearTimeout(this.#grantTimer);
    for (const known of this.#known.values()) clearTimeout(known.timer);
    for (const peer of this.#allPeers()) peer.ws.terminate();
    this.#wss.close();
    this.#lan?.stop();
    for (const request of this.#files.values()) request.resolve(undefined);
  }

  #allPeers(): Peer[] {
    const peers = new Set<Peer>(this.#peers.values());
    for (const known of this.#known.values()) if (known.peer) peers.add(known.peer);
    return [...peers];
  }

  #loadKnown(): string[] {
    const dir = this.#node.options.dataDir;
    if (!dir || !existsSync(join(dir, "peers.json"))) return [];
    try {
      return JSON.parse(readFileSync(join(dir, "peers.json"), "utf8"));
    } catch {
      return [];
    }
  }

  #saveKnown(): void {
    const dir = this.#node.options.dataDir;
    if (!dir) return;
    const urls = [...this.#known.values()].filter((k) => k.persistent).map((k) => k.url);
    writeFileSync(join(dir, "peers.json"), JSON.stringify(urls, null, 1));
  }

  publicAddresses(): string[] {
    return this.#node.options.announce;
  }

  // Connections ---------------------------------------------------------------------

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#setup(ws));
  }

  addPeer(url: string, persistent: boolean): void {
    if (this.#stopped || !/^wss?:\/\//.test(url)) return;
    const normalised = url.replace(/\/+$/, "");
    const selfUrls = [`ws://127.0.0.1:${this.#node.port}/p2p`, `ws://localhost:${this.#node.port}/p2p`];
    if (selfUrls.includes(normalised) || this.#node.options.announce.includes(normalised)) return;
    let known = this.#known.get(normalised);
    if (known) {
      if (persistent && !known.persistent) {
        known.persistent = true;
        this.#saveKnown();
      }
      if (!known.peer && !known.timer) this.#dial(known);
      return;
    }
    if (!persistent && this.#peers.size >= MAX_PEERS) return;
    known = { url: normalised, persistent, attempts: 0 };
    this.#known.set(normalised, known);
    if (persistent) this.#saveKnown();
    this.#dial(known);
  }

  #dial(known: KnownPeer): void {
    if (this.#stopped) return;
    clearTimeout(known.timer);
    known.timer = undefined;
    if (known.node && this.#peers.has(known.node)) return;
    const ws = new WebSocket(known.url, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10_000 });
    const peer = this.#setup(ws, known.url);
    known.peer = peer;
    ws.on("close", () => {
      if (known.peer === peer) known.peer = undefined;
      if (this.#stopped) return;
      if (known.node && this.#peers.has(known.node)) {
        // Already connected to that node through another connection.
        known.timer = setTimeout(() => this.#dial(known), 5 * 60_000);
        return;
      }
      known.attempts++;
      if (!known.persistent && known.attempts > 5) {
        this.#known.delete(known.url);
        return;
      }
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(known.attempts, 6)) * (0.8 + Math.random() * 0.4);
      known.timer = setTimeout(() => this.#dial(known), delay);
    });
  }

  #setup(ws: WebSocket, url?: string): Peer {
    const peer = new Peer(ws, url);
    ws.on("error", (error) => this.#log("debug", `peer ${url ?? "inbound"}: ${error.message}`));
    ws.on("pong", () => {
      peer.alive = true;
    });
    const sendHello = () => {
      const hello: Hello = {
        t: "hello",
        proto: PROTOCOL,
        node: this.#node.nodeId,
        name: this.#node.options.name,
        challenge: peer.challenge,
        announce: this.#node.options.announce,
        relay: this.#node.options.relay,
      };
      peer.send(hello as unknown as Frame);
    };
    if (ws.readyState === ws.OPEN) sendHello();
    else ws.once("open", sendHello);
    ws.on("message", (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        ws.close();
        return;
      }
      peer.lastSeen = Date.now();
      try {
        this.#onFrame(peer, frame);
      } catch (error) {
        this.#log("warn", `bad frame from ${peer.id.slice(0, 8)}: ${(error as Error).stack}`);
      }
    });
    ws.on("close", () => {
      if (peer.ready && this.#peers.get(peer.id) === peer) {
        this.#peers.delete(peer.id);
        this.#node.presence.peerGone(peer.id);
        this.#log("info", `peer disconnected: ${peer.hello?.name} (${peer.id.slice(0, 8)})`);
        // Reconnect through any address we know for that node.
        for (const known of this.#known.values()) {
          if (known.node === peer.id && !known.peer && !this.#stopped) {
            clearTimeout(known.timer);
            known.timer = setTimeout(() => this.#dial(known), 1000);
          }
        }
      }
    });
    setTimeout(() => {
      if (!peer.ready) ws.terminate();
    }, 15_000);
    return peer;
  }

  #onFrame(peer: Peer, frame: Frame): void {
    if (!peer.ready) {
      if (frame.t === "hello") this.#onHello(peer, frame as unknown as Hello);
      else if (frame.t === "auth") this.#onAuth(peer, frame as unknown as Auth);
      return;
    }
    switch (frame.t) {
      case "sub":
        this.#onSub(peer, frame);
        break;
      case "summary":
        this.#onSummary(peer, frame);
        break;
      case "ids?":
        this.#onIdsRequest(peer, frame);
        break;
      case "ids":
        this.#onIds(peer, frame);
        break;
      case "get":
        this.#onGet(peer, frame);
        break;
      case "events":
        this.#onEvents(peer, Array.isArray(frame.events) ? (frame.events as StoatEvent[]) : []);
        break;
      case "event":
        this.#onEvents(peer, [frame.event as StoatEvent]);
        break;
      case "deny":
        this.#log("debug", `peer ${peer.id.slice(0, 8)} denied ${String(frame.scope)}`);
        break;
      case "peers":
        for (const url of Array.isArray(frame.urls) ? frame.urls.slice(0, 50) : []) {
          if (typeof url === "string" && this.#peers.size < MAX_PEERS) this.addPeer(url, false);
        }
        break;
      case "invite?":
        this.#onInviteRequest(peer, frame);
        break;
      case "invite!":
        this.#onInviteAnswer(peer, frame);
        break;
      case "file?":
        void this.#onFileRequest(peer, frame);
        break;
      case "file":
        this.#onFileChunk(frame);
        break;
      case "presence":
        this.#node.presence.remote(
          peer.id,
          (Array.isArray(frame.users) ? frame.users : []).filter((u): u is string => typeof u === "string" && peer.represents(u)),
        );
        break;
      case "typing":
        this.#onTyping(peer, frame);
        break;
      case "users": {
        const before = peer.representedUsers().length;
        peer.verifyAuth(
          { t: "auth", sig: "", users: frame.users as never, delegations: frame.delegations as never, grants: frame.grants as never },
          this.#node.nodeId,
          (d) => this.#onGrant(d),
          true,
        );
        // Re-offer scopes the peer may now read.
        if (peer.representedUsers().length !== before) {
          for (const scope of peer.subscriptions) {
            if (this.#node.store.hasScope(scope) && this.#canServe(peer, scope)) {
              peer.send({ t: "summary", scope, buckets: this.#node.store.summary(scope) });
            }
          }
        }
        break;
      }
    }
  }

  #onHello(peer: Peer, hello: Hello): void {
    if (peer.hello || hello.proto !== PROTOCOL || typeof hello.node !== "string" || typeof hello.challenge !== "string") {
      peer.ws.close();
      return;
    }
    if (hello.node === this.#node.nodeId) {
      // Dialled ourselves (e.g. through a LAN beacon or peer exchange).
      const known = peer.url ? this.#known.get(peer.url) : undefined;
      if (known) known.persistent = false;
      peer.ws.close();
      return;
    }
    peer.hello = hello;
    const own = this.#node.nodeId;
    const auth: Auth = {
      t: "auth",
      sig: signData(this.#node.key, authMessage(hello.challenge, own, hello.node)),
      users: this.#node.accounts
        .list()
        .filter((a) => a.onboarded)
        .map((a) => proveUser(a.id, a.keys, hello.challenge, own)),
      delegations: [...this.#granted.values()].filter((d) => d.exp > Date.now()),
      grants: hello.relay ? this.#grantsFor(hello.node) : [],
    };
    peer.send(auth as unknown as Frame);
  }

  /** Tell connected peers about local users created or onboarded after the handshake. */
  localUsersChanged(): void {
    this.#grants.clear();
    this.#announceUsers();
    this.#recompute();
  }

  #announceUsers(): void {
    for (const peer of this.#peers.values()) {
      const hello = peer.hello!;
      peer.send({
        t: "users",
        users: this.#node.accounts
          .list()
          .filter((a) => a.onboarded)
          .map((a) => proveUser(a.id, a.keys, hello.challenge, this.#node.nodeId)),
        delegations: [...this.#granted.values()].filter((d) => d.exp > Date.now()),
        grants: hello.relay ? this.#grantsFor(hello.node) : [],
      });
    }
  }

  #onGrant(d: Delegation): void {
    const known = this.#granted.get(d.user);
    this.#granted.set(d.user, d);
    if (!known) {
      // Let our other peers know we now relay for this user.
      clearTimeout(this.#grantTimer);
      this.#grantTimer = setTimeout(() => this.#announceUsers(), 50);
    }
  }

  #grantsFor(relay: string): Delegation[] {
    const cached = this.#grants.get(relay);
    if (cached && Date.now() - cached.at < 86_400_000) return cached.list;
    const list = this.#node.accounts
      .list()
      .filter((a) => a.onboarded)
      .map((a) => delegate(a.id, a.keys, relay));
    this.#grants.set(relay, { at: Date.now(), list });
    return list;
  }

  #onAuth(peer: Peer, auth: Auth): void {
    const error = peer.verifyAuth(auth, this.#node.nodeId, (d) => this.#onGrant(d));
    if (error) {
      this.#log("warn", `peer auth failed: ${error}`);
      peer.ws.close();
      return;
    }
    const known = peer.url ? this.#known.get(peer.url) : undefined;
    if (known) known.node = peer.id;
    const existing = this.#peers.get(peer.id);
    if (existing && existing.ws.readyState === existing.ws.OPEN) {
      // Keep a single connection per node: the one dialled by the smaller key wins.
      const keepNew = (peer.url !== undefined) === this.#node.nodeId < peer.id;
      if (!keepNew) {
        peer.ws.close();
        return;
      }
      this.#peers.delete(existing.id);
      existing.ws.close();
    }
    peer.ready = true;
    this.#peers.set(peer.id, peer);
    if (known) known.attempts = 0;
    this.#log("info", `peer connected: ${peer.hello!.name} (${peer.id.slice(0, 8)}) ${peer.url ?? "inbound"}`);

    for (const url of peer.hello!.announce ?? []) {
      if (typeof url === "string" && /^wss?:\/\//.test(url) && peer.url === undefined) this.addPeer(url, false);
    }
    const urls = new Set<string>(this.#node.options.announce);
    for (const other of this.#peers.values()) for (const url of other.hello?.announce ?? []) urls.add(url);
    peer.send({ t: "peers", urls: [...urls].slice(0, 50) });
    this.#subscribeTo(peer, [...this.#interest]);
    this.announcePresence(peer);
  }

  #keepalive(): void {
    for (const peer of this.#allPeers()) {
      if (!peer.alive) {
        peer.ws.terminate();
        continue;
      }
      peer.alive = false;
      if (peer.ws.readyState === peer.ws.OPEN) peer.ws.ping();
    }
  }

  #antiEntropy(): void {
    for (const peer of this.#peers.values()) this.#subscribeTo(peer, [...this.#interest]);
  }

  // Interest and access ------------------------------------------------------------

  #scheduleRecompute(): void {
    clearTimeout(this.#recomputeTimer);
    this.#recomputeTimer = setTimeout(() => this.#recompute(), 50);
  }

  #recompute(): void {
    const world = this.#world;
    const local = this.#node.accounts.list().map((a) => a.id);
    const next = new Set<string>(this.#explicit);
    for (const user of local) next.add(`user:${user}`);
    for (const state of world.servers.values()) {
      const member = state.snap.server && !state.snap.server.deleted && local.some((u) => state.snap.members[u]);
      if (member || this.#inviteFor.has(state.scope)) {
        next.add(state.scope);
        for (const user of Object.keys(state.snap.members)) next.add(`user:${user}`);
      }
    }
    for (const dm of world.dms.values()) {
      if (dm.users.some((u) => local.includes(u))) {
        next.add(dm.scope);
        for (const user of dm.users) next.add(`user:${user}`);
      }
    }
    if (this.#node.options.relay) {
      for (const peer of this.#peers.values()) for (const scope of peer.subscriptions) next.add(scope);
    }
    const added = [...next].filter((scope) => !this.#interest.has(scope));
    this.#interest = next;
    if (added.length) for (const peer of this.#peers.values()) this.#subscribeTo(peer, added);
  }

  #interested(scope: string): boolean {
    return this.#interest.has(scope);
  }

  /** Ask to be kept up to date about a scope (and fetch it now). */
  subscribe(scope: string): void {
    if (!parseScope(scope)) return;
    this.#explicit.add(scope);
    if (!this.#interest.has(scope)) {
      this.#interest.add(scope);
      for (const peer of this.#peers.values()) this.#subscribeTo(peer, [scope]);
    }
  }

  #subscribeTo(peer: Peer, scopes: string[]): void {
    const list = scopes.filter((s) => !s.startsWith("saved:")).map((scope) => ({ scope, invite: this.#inviteFor.get(scope) }));
    for (let i = 0; i < list.length; i += 500) peer.send({ t: "sub", scopes: list.slice(i, i + 500) });
  }

  #canServe(peer: Peer, scope: string): boolean {
    const parsed = parseScope(scope);
    if (!parsed) return false;
    switch (parsed.kind) {
      case "user":
        return true;
      case "saved":
        return false;
      case "dm":
        return parsed.users.some((u) => peer.represents(u));
      case "server": {
        const state = this.#world.servers.get(parsed.server);
        if (!state?.snap.server) return false;
        if (peer.representedUsers().some((u) => state.snap.members[u])) return true;
        const code = peer.invites.get(scope);
        return !!code && !!state.snap.invites[code];
      }
    }
  }

  // Reconciliation ----------------------------------------------------------------------

  #onSub(peer: Peer, frame: Frame): void {
    const scopes = Array.isArray(frame.scopes) ? frame.scopes.slice(0, 5000) : [];
    let relayAdded = false;
    for (const entry of scopes as Array<{ scope?: unknown; invite?: unknown }>) {
      const scope = entry?.scope;
      if (typeof scope !== "string" || !parseScope(scope) || scope.startsWith("saved:")) continue;
      if (typeof entry.invite === "string") {
        peer.invites.set(scope, entry.invite);
        if (this.#node.options.relay && !this.#inviteFor.has(scope)) this.#inviteFor.set(scope, entry.invite);
      }
      peer.subscriptions.add(scope);
      if (this.#node.options.relay && !this.#interest.has(scope)) relayAdded = true;
      const parsed = parseScope(scope);
      if (parsed?.kind === "dm" && !this.#interest.has(scope) && parsed.users.some((u) => this.#node.accounts.get(u))) {
        // Someone wants to talk to one of our users: start following that conversation.
        this.#world.dmState(scope);
        this.subscribe(scope);
      }
      if (!this.#node.store.hasScope(scope)) continue;
      if (this.#canServe(peer, scope)) peer.send({ t: "summary", scope, buckets: this.#node.store.summary(scope) });
      else peer.send({ t: "deny", scope });
    }
    if (relayAdded) this.#recompute();
  }

  #onSummary(peer: Peer, frame: Frame): void {
    const scope = frame.scope as string;
    if (typeof scope !== "string" || !this.#interested(scope)) return;
    const theirs = (frame.buckets ?? {}) as Record<string, [number, string]>;
    const mine = this.#node.store.summary(scope);
    const want = Object.entries(theirs)
      .filter(([bucket, value]) => Array.isArray(value) && mine[bucket]?.[1] !== value[1])
      .map(([bucket]) => Number(bucket));
    if (want.length) peer.send({ t: "ids?", scope, buckets: want.slice(0, 5000) });
  }

  #onIdsRequest(peer: Peer, frame: Frame): void {
    const scope = frame.scope as string;
    if (typeof scope !== "string" || !this.#canServe(peer, scope)) return;
    const buckets = Array.isArray(frame.buckets) ? frame.buckets.slice(0, 5000) : [];
    const ids: string[] = [];
    for (const bucket of buckets) if (typeof bucket === "number") ids.push(...this.#node.store.bucketIds(scope, bucket));
    for (let i = 0; i < ids.length || i === 0; i += 5000) peer.send({ t: "ids", scope, ids: ids.slice(i, i + 5000) });
  }

  #onIds(peer: Peer, frame: Frame): void {
    const scope = frame.scope as string;
    if (typeof scope !== "string" || !this.#interested(scope)) return;
    const ids = (Array.isArray(frame.ids) ? frame.ids : []).filter(
      (id): id is string => typeof id === "string" && /^[0-9a-f]{64}$/.test(id) && !this.#node.store.has(id),
    );
    for (let i = 0; i < ids.length; i += 1000) peer.send({ t: "get", ids: ids.slice(i, i + 1000) });
  }

  #onGet(peer: Peer, frame: Frame): void {
    const ids = Array.isArray(frame.ids) ? frame.ids.slice(0, 5000) : [];
    const events: StoatEvent[] = [];
    const allowed = new Map<string, boolean>();
    for (const id of ids) {
      const event = typeof id === "string" ? this.#node.store.get(id) : undefined;
      if (!event) continue;
      let ok = allowed.get(event.scope);
      if (ok === undefined) allowed.set(event.scope, (ok = this.#canServe(peer, event.scope)));
      if (ok) events.push(event);
    }
    // Oldest first helps the receiver apply events without waiting.
    events.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < events.length; i += EVENTS_PER_FRAME) peer.send({ t: "events", events: events.slice(i, i + EVENTS_PER_FRAME) });
  }

  #onEvents(peer: Peer, events: StoatEvent[]): void {
    const accepted = events.filter((e) => typeof e?.scope === "string" && this.#interested(e.scope));
    if (!accepted.length) return;
    this.#world.batch(() => {
      for (const event of accepted) {
        const result = this.#world.ingest(event, { source: peer.id });
        if (result.status === "rejected") this.#log("debug", `rejected event from ${peer.id.slice(0, 8)}: ${result.reason}`);
      }
    });
  }

  #forward(event: StoatEvent, source?: string): void {
    for (const peer of this.#peers.values()) {
      if (peer.id === source || !peer.subscriptions.has(event.scope)) continue;
      if (this.#canServe(peer, event.scope)) peer.send({ t: "event", event });
    }
  }

  #requestMissing(ids: string[], source?: string): void {
    const peer = source ? this.#peers.get(source) : undefined;
    const targets = peer ? [peer] : [...this.#peers.values()];
    for (const target of targets) target.send({ t: "get", ids });
  }

  /** Subscribe to a scope and wait (up to `timeout`) until something arrives. */
  async fetchScope(scope: string, timeout: number): Promise<void> {
    this.subscribe(scope);
    const start = Date.now();
    while (!this.#node.store.hasScope(scope) && Date.now() - start < timeout && this.#peers.size) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Invites --------------------------------------------------------------------------

  async lookupInvite(code: string, timeout = 10_000): Promise<void> {
    if (!this.#peers.size) return;
    const rid = b64u(randomBytes(12));
    for (const peer of this.#peers.values()) peer.send({ t: "invite?", rid, code, ttl: 2 });
    const start = Date.now();
    while (!findInvite(this.#node, code) && Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  #onInviteRequest(peer: Peer, frame: Frame): void {
    const { rid, code } = frame as { rid?: unknown; code?: unknown };
    if (typeof rid !== "string" || typeof code !== "string" || this.#forwarded.has(rid)) return;
    const found = findInvite(this.#node, code);
    if (found) {
      peer.send({ t: "invite!", rid, code, scope: found.state.scope });
      return;
    }
    const ttl = Number(frame.ttl) || 0;
    if (this.#node.options.relay && ttl > 0) {
      this.#forwarded.set(rid, peer);
      setTimeout(() => this.#forwarded.delete(rid), 30_000);
      for (const other of this.#peers.values()) {
        if (other !== peer) other.send({ t: "invite?", rid, code, ttl: ttl - 1 });
      }
    }
  }

  #onInviteAnswer(peer: Peer, frame: Frame): void {
    const { rid, code, scope } = frame as { rid?: unknown; code?: unknown; scope?: unknown };
    if (typeof code !== "string" || typeof scope !== "string" || parseScope(scope)?.kind !== "server") return;
    if (!this.#inviteFor.has(scope)) this.#inviteFor.set(scope, code);
    this.subscribe(scope);
    peer.send({ t: "sub", scopes: [{ scope, invite: code }] });
    const back = typeof rid === "string" ? this.#forwarded.get(rid) : undefined;
    if (back) {
      // Answer once we hold the scope ourselves, so the requester can sync from us.
      const started = Date.now();
      const wait = () => {
        if (findInvite(this.#node, code)) back.send({ t: "invite!", rid, code, scope });
        else if (Date.now() - started < 10_000) setTimeout(wait, 100);
      };
      wait();
    }
  }

  // Files ---------------------------------------------------------------------------------

  fetchFile(hash: string, except?: Peer, timeout = 15_000): Promise<Buffer | undefined> {
    const existing = this.#files.get(hash);
    if (existing) return existing.promise;
    const peers = [...this.#peers.values()].filter((p) => p !== except);
    if (!peers.length) return Promise.resolve(undefined);
    let resolve!: (data: Buffer | undefined) => void;
    const promise = new Promise<Buffer | undefined>((r) => (resolve = r));
    const request: FileRequest = { hash, chunks: new Map(), resolve, promise };
    this.#files.set(hash, request);
    const timer = setTimeout(() => request.resolve(undefined), timeout);
    void promise.then(() => {
      clearTimeout(timer);
      this.#files.delete(hash);
    });
    for (const peer of peers) peer.send({ t: "file?", hash });
    return promise;
  }

  async #onFileRequest(peer: Peer, frame: Frame): Promise<void> {
    const hash = frame.hash;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return;
    let data = this.#node.files.get(hash);
    if (!data && this.#node.options.relay) {
      data = await this.fetchFile(hash, peer);
      if (data) this.#node.files.putVerified(hash, data);
    }
    if (!data) return;
    const total = Math.max(1, Math.ceil(data.length / FILE_CHUNK));
    for (let seq = 0; seq < total; seq++) {
      peer.send({ t: "file", hash, seq, total, data: data.subarray(seq * FILE_CHUNK, (seq + 1) * FILE_CHUNK).toString("base64") });
    }
  }

  #onFileChunk(frame: Frame): void {
    const { hash, seq, total, data } = frame as { hash?: unknown; seq?: unknown; total?: unknown; data?: unknown };
    const request = typeof hash === "string" ? this.#files.get(hash) : undefined;
    if (!request || typeof seq !== "number" || typeof total !== "number" || typeof data !== "string" || total > 64) return;
    // Chunks may arrive from several peers at once; keep them per sender count.
    const key = String(total);
    let chunks = request.chunks.get(key);
    if (!chunks) request.chunks.set(key, (chunks = new Array(total)));
    chunks[seq] = Buffer.from(data, "base64");
    if (chunks.filter(Boolean).length === total) {
      const buffer = Buffer.concat(chunks);
      if (this.#node.files.putVerified(request.hash, buffer)) request.resolve(buffer);
      else request.chunks.delete(key);
    }
  }

  // Ephemeral signals ----------------------------------------------------------------------

  announcePresence(only?: Peer): void {
    const local = new Set([...this.#node.bonfire.connections].map((c) => c.account.id));
    const users = [...local];
    if (this.#node.options.relay) {
      for (const peer of this.#peers.values()) {
        for (const user of peer.representedUsers()) if (this.#node.presence.isOnline(user)) users.push(user);
      }
    }
    const targets = only ? [only] : [...this.#peers.values()];
    for (const peer of targets) peer.send({ t: "presence", users: [...new Set(users)] });
  }

  sendTyping(user: string, channel: string, on: boolean): void {
    const ref = this.#world.channel(channel);
    if (!ref || ref.kind === "saved") return;
    const scope = ref.kind === "server" ? serverScope(ref.server) : ref.scope;
    for (const peer of this.#peers.values()) {
      if (peer.subscriptions.has(scope) && this.#canServe(peer, scope)) peer.send({ t: "typing", user, channel, on, ttl: 1 });
    }
  }

  #onTyping(peer: Peer, frame: Frame): void {
    const { user, channel, on } = frame as { user?: unknown; channel?: unknown; on?: unknown };
    if (typeof user !== "string" || typeof channel !== "string" || !peer.represents(user)) return;
    this.#node.typing(user, channel, on === true, true);
    const ttl = Number(frame.ttl) || 0;
    if (this.#node.options.relay && ttl > 0) {
      const ref = this.#world.channel(channel);
      if (!ref || ref.kind === "saved") return;
      const scope = ref.kind === "server" ? serverScope(ref.server) : ref.scope;
      for (const other of this.#peers.values()) {
        if (other !== peer && other.subscriptions.has(scope) && this.#canServe(other, scope)) {
          other.send({ t: "typing", user, channel, on, ttl: ttl - 1 });
        }
      }
    }
  }

  /** Dial the home nodes a user lists in their profile. */
  connectToUser(user: string): void {
    for (const url of this.#world.profiles.get(user)?.nodes ?? []) this.addPeer(url, false);
  }

  // Introspection ---------------------------------------------------------------------------

  get connectedCount(): number {
    return this.#peers.size;
  }

  status() {
    const peers: PeerStatus[] = [];
    const seen = new Set<string>();
    for (const peer of this.#peers.values()) {
      seen.add(peer.id);
      peers.push({
        id: peer.id,
        name: peer.hello?.name ?? "",
        url: peer.url,
        connected: true,
        relay: !!peer.hello?.relay,
        users: peer.representedUsers().length,
        scopes: peer.subscriptions.size,
      });
    }
    for (const known of this.#known.values()) {
      if (known.node && seen.has(known.node)) continue;
      peers.push({ id: known.node ?? "", name: "", url: known.url, connected: false, relay: false, users: 0, scopes: 0 });
    }
    return {
      node: this.#node.nodeId,
      name: this.#node.options.name,
      relay: this.#node.options.relay,
      announce: this.#node.options.announce,
      events: this.#node.store.size,
      scopes: this.#node.store.scopes().length,
      pending: this.#world.pendingCount,
      interest: this.#interest.size,
      peers,
    };
  }
}
