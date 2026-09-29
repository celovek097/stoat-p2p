// The World holds everything a node knows: it ingests verified events from
// the local API and from peers, keeps causal order (events wait until their
// dependencies arrive), and emits changes for connected clients.

import { EventEmitter } from "node:events";

import {
  CONTENT_TYPES,
  DM_STATE_TYPES,
  LIMITS,
  objectId,
  parseScope,
  SERVER_STATE_TYPES,
  savedChannelId,
  type StoatEvent,
  USER_TYPES,
  verifyEvent,
} from "../core/event.ts";
import type { EventStore } from "../core/store.ts";
import { isUlid, SYSTEM_USER_ID } from "../core/ulid.ts";
import { type ServerChange, diffSnapshots } from "./diff.ts";
import { ChannelMessages } from "./messages.ts";
import { has, Permission } from "./permissions.ts";
import { channelPermissions, isColour, isFile, isName, isText, ServerState } from "./server.ts";
import type { FileObject, MessageData, ProfileData, RelationshipStatus, ServerSnapshot } from "./types.ts";

export type IngestStatus = "accepted" | "duplicate" | "pending" | "rejected";

export interface IngestResult {
  status: IngestStatus;
  reason?: string;
  missing?: string[];
}

export type ChannelRef =
  | { kind: "server"; server: string; channel: string }
  | { kind: "dm"; scope: string; channel: string; users: [string, string] }
  | { kind: "saved"; user: string; channel: string };

export type WorldChange =
  | { type: "server"; server: string; changes: ServerChange[] }
  | { type: "message.create"; message: MessageData }
  | { type: "message.update"; message: MessageData; data: Record<string, unknown>; clear?: string[] }
  | { type: "message.delete"; channel: string; id: string }
  | { type: "message.react"; channel: string; id: string; user: string; emoji: string; on: boolean }
  | { type: "message.clear"; channel: string; id: string; emoji: string }
  | { type: "profile"; user: string; profile: ProfileData; previous?: ProfileData }
  | { type: "dm"; scope: string; channel: string; users: [string, string] }
  | { type: "relation"; users: [string, string] };

export interface DmState {
  scope: string;
  channel: string;
  users: [string, string];
  relationEvents: StoatEvent[];
  statuses: Record<string, RelationshipStatus>;
}

interface Pending {
  event: StoatEvent;
  missing: Set<string>;
  source?: string;
  since: number;
}

/** Decrypts an end-to-end encrypted DM body; null when this node cannot. */
export type Decryptor = (event: StoatEvent) => Record<string, unknown> | null;

const RE_USER_MENTION = /<@([0-9A-HJKMNP-TV-Z]{26})>/g;
const RE_ROLE_MENTION = /<%([0-9A-HJKMNP-TV-Z]{26})>/g;
const MAX_PENDING = 20_000;
const PENDING_TTL = 15 * 60 * 1000;

function lww(key: string | undefined, candidate: string): boolean {
  return !key || candidate > key;
}

function clockKey(event: StoatEvent): string {
  return `${String(event.ts).padStart(15, "0")}:${event.id}`;
}

function isEmoji(value: unknown): value is string {
  return (typeof value === "string" && value.length > 0 && value.length <= 32 && !/\s/.test(value)) || isUlid(value);
}

export class World extends EventEmitter {
  readonly store: EventStore;
  readonly servers = new Map<string, ServerState>();
  readonly profiles = new Map<string, ProfileData>();
  readonly dms = new Map<string, DmState>();
  readonly channels = new Map<string, ChannelRef>();
  readonly messages = new Map<string, ChannelMessages>();
  readonly messageChannel = new Map<string, string>();
  decryptor: Decryptor | undefined;

  readonly #pending = new Map<string, Pending>();
  readonly #waiters = new Map<string, Set<string>>();
  #batchDepth = 0;
  readonly #batchSnapshots = new Map<string, ServerSnapshot>();
  readonly #batchContent: StoatEvent[] = [];

  constructor(store: EventStore) {
    super();
    this.setMaxListeners(100);
    this.store = store;
  }

  // -------------------------------------------------------------------------
  // Loading and ingestion

  /** Rebuild state from the persisted log. */
  load(): number {
    const events = this.store.load();
    this.batch(() => {
      for (const event of events) this.ingest(event, { persist: false, trusted: true });
    });
    return events.length;
  }

  /** Group many ingests: re-folds and client notifications happen once. */
  batch<T>(fn: () => T): T {
    this.#batchDepth++;
    try {
      return fn();
    } finally {
      this.#batchDepth--;
      if (this.#batchDepth === 0) this.#flushBatch();
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  missingDependencies(): string[] {
    return [...this.#waiters.keys()].filter((id) => !this.store.has(id));
  }

  ingest(event: StoatEvent, options: { persist?: boolean; trusted?: boolean; source?: string } = {}): IngestResult {
    if (this.store.has(event?.id) || this.#pending.has(event?.id)) return { status: "duplicate" };
    if (!options.trusted) {
      const error = verifyEvent(event);
      if (error) return { status: "rejected", reason: error };
    }
    const scopeError = this.#checkScope(event);
    if (scopeError) return { status: "rejected", reason: scopeError };

    const missing = event.deps.filter((dep) => !this.store.has(dep));
    if (missing.length) {
      this.#expirePending();
      if (this.#pending.size >= MAX_PENDING) return { status: "rejected", reason: "too many pending events" };
      this.#pending.set(event.id, { event, missing: new Set(missing), source: options.source, since: Date.now() });
      for (const dep of missing) {
        let set = this.#waiters.get(dep);
        if (!set) this.#waiters.set(dep, (set = new Set()));
        set.add(event.id);
      }
      this.emit("missing", missing, options.source);
      return { status: "pending", missing };
    }

    const result = this.#accept(event, options.persist !== false, options.source);
    if (result.status === "accepted") this.#release(event.id, options.persist !== false);
    return result;
  }

  #checkScope(event: StoatEvent): string | null {
    const scope = parseScope(event.scope);
    if (!scope) return "bad scope";
    switch (scope.kind) {
      case "user":
        if (!USER_TYPES.has(event.type)) return "unexpected type for user scope";
        if (event.author !== scope.user) return "profile not signed by its user";
        return null;
      case "saved":
        if (!CONTENT_TYPES.has(event.type)) return "unexpected type for saved scope";
        if (event.author !== scope.user) return "saved messages belong to one user";
        return null;
      case "dm":
        if (!CONTENT_TYPES.has(event.type) && !DM_STATE_TYPES.has(event.type)) return "unexpected type for dm scope";
        if (!scope.users.includes(event.author)) return "not a participant";
        return null;
      case "server":
        if (!SERVER_STATE_TYPES.has(event.type) && !CONTENT_TYPES.has(event.type)) return "unexpected type";
        if (event.type === "server.create") return event.deps.length ? "genesis with dependencies" : null;
        return event.deps.length ? null : "missing dependencies";
    }
    return "unknown scope";
  }

  #release(id: string, persist: boolean): void {
    const queue = [id];
    while (queue.length) {
      const done = queue.shift()!;
      const waiting = this.#waiters.get(done);
      if (!waiting) continue;
      this.#waiters.delete(done);
      for (const pendingId of waiting) {
        const pending = this.#pending.get(pendingId);
        if (!pending) continue;
        pending.missing.delete(done);
        if (pending.missing.size === 0) {
          this.#pending.delete(pendingId);
          const result = this.#accept(pending.event, persist, pending.source);
          if (result.status === "accepted") queue.push(pendingId);
        }
      }
    }
  }

  #expirePending(): void {
    const now = Date.now();
    for (const [id, pending] of this.#pending) {
      if (now - pending.since < PENDING_TTL) continue;
      this.#pending.delete(id);
      for (const dep of pending.missing) {
        const set = this.#waiters.get(dep);
        set?.delete(id);
        if (set && !set.size) this.#waiters.delete(dep);
      }
    }
  }

  #accept(event: StoatEvent, persist: boolean, source?: string): IngestResult {
    for (const dep of event.deps) {
      if (this.store.get(dep)?.scope !== event.scope) return { status: "rejected", reason: "dependency from another scope" };
    }
    const scope = parseScope(event.scope)!;
    if (scope.kind === "server" && event.type !== "server.create" && event.type !== "member.join") {
      // Only people who (tried to) join may write into a server: drops spam
      // from strangers before it is stored or forwarded.
      if (!this.servers.get(scope.server)?.joinAuthors.has(event.author)) {
        return { status: "rejected", reason: "author never joined this server" };
      }
    }
    this.store.add(event, persist);
    switch (scope.kind) {
      case "user":
        this.#applyProfile(event);
        break;
      case "server":
        this.#applyServer(scope.server, event);
        break;
      case "dm":
        this.#applyDm(event.scope, event);
        break;
      case "saved":
        this.#applyContent(event, { kind: "saved", user: scope.user, channel: savedChannelId(scope.user) });
        break;
    }
    this.emit("accepted", event, source);
    return { status: "accepted" };
  }

  #flushBatch(): void {
    for (const [serverId, before] of this.#batchSnapshots) {
      const state = this.servers.get(serverId)!;
      if (state.dirty) state.refold();
      this.#afterServerChange(state, before);
    }
    this.#batchSnapshots.clear();
    const content = this.#batchContent.splice(0);
    for (const event of content) {
      const scope = parseScope(event.scope);
      if (scope?.kind === "server") this.#applyServerContent(this.servers.get(scope.server)!, event);
    }
  }

  // -------------------------------------------------------------------------
  // Servers

  #applyServer(serverId: string, event: StoatEvent): void {
    let state = this.servers.get(serverId);
    if (!state) {
      state = new ServerState(serverId);
      this.servers.set(serverId, state);
    }
    if (CONTENT_TYPES.has(event.type)) {
      if (this.#batchDepth > 0 && (state.dirty || this.#batchSnapshots.has(serverId))) {
        this.#batchContent.push(event);
      } else {
        this.#applyServerContent(state, event);
      }
      return;
    }

    if (this.#batchDepth > 0) {
      if (!this.#batchSnapshots.has(serverId)) this.#batchSnapshots.set(serverId, structuredClone(state.snap));
      state.add(event, true);
      return;
    }
    const before = structuredClone(state.snap);
    state.add(event);
    this.#afterServerChange(state, before);
  }

  #afterServerChange(state: ServerState, before: ServerSnapshot): void {
    const changes = diffSnapshots(before, state.snap);
    const after = state.snap;
    // Keep the channel index in sync.
    for (const id of Object.keys(before.channels)) if (!after.channels[id]) this.channels.delete(id);
    for (const id of Object.keys(after.channels)) {
      this.channels.set(id, { kind: "server", server: state.id, channel: id });
      if (!this.messages.has(id)) this.messages.set(id, new ChannelMessages());
    }
    if (after.server?.deleted) for (const id of Object.keys(after.channels)) this.channels.delete(id);
    for (const change of changes) {
      if (change.kind === "system.add") {
        const m = change.message;
        const message: MessageData = {
          id: m.id,
          channel: m.channel,
          author: SYSTEM_USER_ID,
          event: m.id,
          ts: m.ts,
          system: m.system,
          reactions: {},
        };
        this.#channelMessages(m.channel).add(message);
        this.messageChannel.set(m.id, m.channel);
      } else if (change.kind === "system.remove") {
        this.#channelMessages(change.message.channel).remove(change.message.id);
      }
    }
    if (changes.length) this.emit("change", { type: "server", server: state.id, changes } satisfies WorldChange);
  }

  #channelMessages(channel: string): ChannelMessages {
    let messages = this.messages.get(channel);
    if (!messages) this.messages.set(channel, (messages = new ChannelMessages()));
    return messages;
  }

  #applyServerContent(state: ServerState, event: StoatEvent): void {
    const channel = (event.type === "message.send" ? event.body.channel : this.messageChannel.get(event.body.message as string)) as
      | string
      | undefined;
    if (!channel || !state.snap.channels[channel]) return;
    this.#applyContent(event, { kind: "server", server: state.id, channel }, state);
  }

  // -------------------------------------------------------------------------
  // Messages (shared by servers, DMs and saved messages)

  #applyContent(event: StoatEvent, ref: ChannelRef, state?: ServerState): void {
    let body = event.body;
    if (ref.kind === "dm" && body.enc) {
      const plain = this.decryptor?.(event);
      if (!plain) return;
      body = plain;
    }
    const messages = this.#channelMessages(ref.channel);
    const perms = () =>
      state ? channelPermissions(state.snap, ref.channel, event.author, event.ts) : Permission.GrantAllSafe;

    if (event.type === "message.send") {
      const id = objectId(event);
      if (messages.get(id)) return;
      const message = this.#buildMessage(event, body, ref, id);
      if (!message) return;
      if (state) {
        const depPos = state.depPosition(event.deps);
        const snap = state.snap;
        const ban = snap.bans[event.author];
        if (!state.memberAt(event.author, depPos)) message.hidden = true;
        else if (ban && event.ts >= ban.ts) message.hidden = true;
        else if (snap.members[event.author]) {
          const p = perms();
          if (!has(p, Permission.SendMessage)) message.hidden = true;
          if (message.attachments?.length && !has(p, Permission.UploadFiles)) message.hidden = true;
          if (message.masquerade && !has(p, Permission.Masquerade)) message.hidden = true;
          if (message.embeds?.length && !has(p, Permission.SendEmbeds)) message.hidden = true;
        }
        if (message.mentions) message.mentions = message.mentions.filter((user) => snap.members[user]);
        if (message.role_mentions) message.role_mentions = message.role_mentions.filter((role) => snap.server?.roles[role]);
      } else if (ref.kind === "dm") {
        const dm = this.dms.get(ref.scope);
        const status = dm?.statuses[event.author];
        if (status === "Blocked" || status === "BlockedOther") message.hidden = true;
      }
      messages.add(message);
      this.messageChannel.set(id, ref.channel);
      if (!message.hidden) {
        this.emit("change", { type: "message.create", message } satisfies WorldChange);
        if (ref.kind === "dm") this.emit("change", { type: "dm", scope: ref.scope, channel: ref.channel, users: ref.users });
      }
      return;
    }

    const target = messages.get(body.message as string);
    if (!target || target.deleted || target.system) return;
    const key = clockKey(event);

    switch (event.type) {
      case "message.edit": {
        if (target.author !== event.author || !lww(target.editKey, key)) return;
        const data: Record<string, unknown> = {};
        if (body.content !== undefined) {
          if (!isText(body.content, 0, LIMITS.content)) return;
          target.content = body.content;
          data.content = body.content;
          const mentions = this.#mentions(body.content);
          target.mentions = state ? mentions.users.filter((u) => state.snap.members[u]) : mentions.users;
          data.mentions = target.mentions;
        }
        if (Array.isArray(body.embeds)) {
          target.embeds = this.#textEmbeds(body.embeds);
          data.embeds = target.embeds;
        }
        target.edited = event.ts;
        target.editKey = key;
        data.edited = new Date(event.ts).toISOString();
        if (!target.hidden) this.emit("change", { type: "message.update", message: target, data } satisfies WorldChange);
        return;
      }
      case "message.delete": {
        if (target.author !== event.author && !has(perms(), Permission.ManageMessages)) return;
        target.deleted = true;
        if (!target.hidden) this.emit("change", { type: "message.delete", channel: ref.channel, id: target.id } satisfies WorldChange);
        return;
      }
      case "message.react":
      case "message.unreact": {
        const emoji = body.emoji;
        if (!isEmoji(emoji)) return;
        const on = event.type === "message.react";
        const user = on ? event.author : ((body.user as string | undefined) ?? event.author);
        if (on) {
          if (!has(perms(), Permission.React)) return;
          const interactions = target.interactions as { reactions?: string[]; restrict_reactions?: boolean } | undefined;
          if (interactions?.restrict_reactions && !interactions.reactions?.includes(emoji)) return;
          if (!target.reactions[emoji] && Object.keys(target.reactions).length >= 20) return;
        } else if (user !== event.author && !has(perms(), Permission.ManageMessages)) {
          return;
        }
        const users = (target.reactions[emoji] ??= {});
        const current = users[user];
        if (!lww(current?.slice(0, -2), key)) return;
        const wasOn = current?.endsWith(":1") ?? false;
        users[user] = `${key}:${on ? 1 : 0}`;
        if (wasOn !== on && !target.hidden) {
          this.emit("change", { type: "message.react", channel: ref.channel, id: target.id, user, emoji, on } satisfies WorldChange);
        }
        return;
      }
      case "message.clear_reactions": {
        if (!has(perms(), Permission.ManageMessages)) return;
        const emojis = typeof body.emoji === "string" ? [body.emoji] : Object.keys(target.reactions);
        for (const emoji of emojis) {
          const users = target.reactions[emoji];
          if (!users) continue;
          let changed = false;
          for (const [user, value] of Object.entries(users)) {
            if (lww(value.slice(0, -2), key)) {
              if (value.endsWith(":1")) changed = true;
              users[user] = `${key}:0`;
            }
          }
          if (changed && !target.hidden) {
            this.emit("change", { type: "message.clear", channel: ref.channel, id: target.id, emoji } satisfies WorldChange);
          }
        }
        return;
      }
      case "message.pin":
      case "message.unpin": {
        if (!has(perms(), Permission.ManageMessages) || !lww(target.pinKey, key)) return;
        target.pinned = event.type === "message.pin";
        target.pinKey = key;
        if (!target.hidden) {
          this.emit("change", {
            type: "message.update",
            message: target,
            data: target.pinned ? { pinned: true } : {},
            clear: target.pinned ? [] : ["Pinned"],
          } satisfies WorldChange);
        }
        return;
      }
    }
  }

  #mentions(content: string): { users: string[]; roles: string[] } {
    return {
      users: [...new Set([...content.matchAll(RE_USER_MENTION)].map((m) => m[1]!))],
      roles: [...new Set([...content.matchAll(RE_ROLE_MENTION)].map((m) => m[1]!))],
    };
  }

  #textEmbeds(embeds: unknown[]): Array<Record<string, unknown>> {
    return embeds.slice(0, 10).flatMap((raw) => {
      if (typeof raw !== "object" || raw === null) return [];
      const e = raw as Record<string, unknown>;
      const embed: Record<string, unknown> = { type: "Text" };
      for (const key of ["icon_url", "url", "title", "description"] as const) {
        if (isText(e[key], 1, key === "description" ? 2000 : 256)) embed[key] = e[key];
      }
      if (isColour(e.colour)) embed.colour = e.colour;
      return [embed];
    });
  }

  #buildMessage(event: StoatEvent, body: Record<string, unknown>, ref: ChannelRef, id: string): MessageData | null {
    const message: MessageData = { id, channel: ref.channel, author: event.author, event: event.id, ts: event.ts, reactions: {} };
    if (body.content !== undefined) {
      if (!isText(body.content, 0, LIMITS.content)) return null;
      if (body.content.length) message.content = body.content;
    }
    if (body.attachments !== undefined) {
      if (!Array.isArray(body.attachments) || body.attachments.length > 10) return null;
      if (!body.attachments.every((file) => isFile(file, "attachments"))) return null;
      if (body.attachments.length) message.attachments = body.attachments as FileObject[];
    }
    if (body.embeds !== undefined) {
      if (!Array.isArray(body.embeds)) return null;
      const embeds = this.#textEmbeds(body.embeds);
      if (embeds.length) message.embeds = embeds;
    }
    if (!message.content && !message.attachments && !message.embeds) return null;
    if (isText(body.nonce, 1, 64)) message.nonce = body.nonce;
    if (body.masquerade !== undefined) {
      const m = body.masquerade as Record<string, unknown>;
      if (typeof m !== "object" || m === null) return null;
      const masquerade: Record<string, unknown> = {};
      if (m.name !== undefined) {
        if (!isName(m.name, 1, 32)) return null;
        masquerade.name = m.name;
      }
      if (m.avatar !== undefined) {
        if (!isText(m.avatar, 1, 256)) return null;
        masquerade.avatar = m.avatar;
      }
      if (m.colour !== undefined) {
        if (!isColour(m.colour)) return null;
        masquerade.colour = m.colour;
      }
      message.masquerade = masquerade;
    }
    if (body.interactions !== undefined) {
      const i = body.interactions as Record<string, unknown>;
      if (typeof i !== "object" || i === null) return null;
      const reactions = Array.isArray(i.reactions) ? [...new Set(i.reactions.filter(isEmoji))].slice(0, 20) : undefined;
      message.interactions = {
        reactions,
        restrict_reactions: i.restrict_reactions === true && !!reactions?.length,
      };
    }
    if (Number.isSafeInteger(body.flags)) message.flags = body.flags as number;

    const mentions = this.#mentions(message.content ?? "");
    const replies: string[] = [];
    if (Array.isArray(body.replies)) {
      for (const reply of body.replies.slice(0, 5)) {
        const r = reply as { id?: unknown; mention?: unknown };
        if (!isUlid(r?.id)) continue;
        replies.push(r.id);
        if (r.mention === true) {
          const channel = this.messageChannel.get(r.id);
          const author = channel ? this.messages.get(channel)?.get(r.id)?.author : undefined;
          if (author && author !== SYSTEM_USER_ID && !mentions.users.includes(author)) mentions.users.push(author);
        }
      }
    }
    if (replies.length) message.replies = replies;
    if (mentions.users.length) message.mentions = mentions.users;
    if (mentions.roles.length) message.role_mentions = mentions.roles;
    if (ref.kind === "dm" && event.body.enc) message.encrypted = true;
    return message;
  }

  // -------------------------------------------------------------------------
  // Direct messages and relationships

  dmState(scope: string): DmState {
    let dm = this.dms.get(scope);
    if (!dm) {
      const parsed = parseScope(scope);
      if (parsed?.kind !== "dm") throw new Error(`not a dm scope: ${scope}`);
      dm = {
        scope,
        channel: parsed.channel,
        users: parsed.users,
        relationEvents: [],
        statuses: { [parsed.users[0]]: "None", [parsed.users[1]]: "None" },
      };
      this.dms.set(scope, dm);
      this.channels.set(dm.channel, { kind: "dm", scope, channel: dm.channel, users: dm.users });
    }
    return dm;
  }

  #applyDm(scope: string, event: StoatEvent): void {
    const dm = this.dmState(scope);
    if (event.type === "relation.set") {
      if (!["request", "accept", "remove", "block", "unblock"].includes(event.body.status as string)) return;
      dm.relationEvents.push(event);
      const before = JSON.stringify(dm.statuses);
      dm.statuses = foldRelations(dm.users, dm.relationEvents);
      if (JSON.stringify(dm.statuses) !== before) this.emit("change", { type: "relation", users: dm.users } satisfies WorldChange);
      return;
    }
    this.#applyContent(event, { kind: "dm", scope, channel: dm.channel, users: dm.users });
  }

  relationship(viewer: string, other: string): RelationshipStatus {
    if (viewer === other) return "User";
    const scope = viewer < other ? `dm:${viewer}:${other}` : `dm:${other}:${viewer}`;
    return this.dms.get(scope)?.statuses[viewer] ?? "None";
  }

  // -------------------------------------------------------------------------
  // Profiles

  #applyProfile(event: StoatEvent): void {
    const body = event.body;
    if (!isText(body.username, 2, 32) || !/^(\p{L}|[\d_.-])+$/u.test(body.username)) return;
    const previous = this.profiles.get(event.author);
    if (previous && !(clockKey(event) > `${String(previous.ts).padStart(15, "0")}:${previous.event}`)) return;
    const profile: ProfileData = { user: event.author, key: event.key, ts: event.ts, event: event.id, username: body.username };
    if (isName(body.display_name, 2, 32)) profile.display_name = body.display_name;
    if (isFile(body.avatar, "avatars")) profile.avatar = body.avatar;
    if (isText(body.pronouns, 1, 64)) profile.pronouns = body.pronouns;
    if (typeof body.status === "object" && body.status !== null) {
      const s = body.status as Record<string, unknown>;
      const status: ProfileData["status"] = {};
      if (isText(s.text, 0, 128)) status.text = s.text;
      if (["Online", "Idle", "Focus", "Busy", "Invisible"].includes(s.presence as string)) status.presence = s.presence as string;
      profile.status = status;
    }
    if (typeof body.profile === "object" && body.profile !== null) {
      const p = body.profile as Record<string, unknown>;
      profile.profile = {};
      if (isText(p.content, 0, 2000)) profile.profile.content = p.content;
      if (isFile(p.background, "backgrounds")) profile.profile.background = p.background;
    }
    if (isText(body.x25519, 43, 43)) profile.x25519 = body.x25519;
    if (Array.isArray(body.nodes)) {
      profile.nodes = body.nodes.filter((a): a is string => isText(a, 1, 256) && /^wss?:\/\//.test(a)).slice(0, 8);
    }
    this.profiles.set(event.author, profile);
    this.emit("change", { type: "profile", user: event.author, profile, previous } satisfies WorldChange);
  }

  // -------------------------------------------------------------------------
  // Queries used by the API layer

  server(id: string): ServerState | undefined {
    const state = this.servers.get(id);
    return state?.snap.server && !state.snap.server.deleted ? state : undefined;
  }

  serversOf(user: string): ServerState[] {
    return [...this.servers.values()].filter((s) => s.snap.server && !s.snap.server.deleted && s.snap.members[user]);
  }

  dmsOf(user: string): DmState[] {
    return [...this.dms.values()].filter((dm) => dm.users.includes(user));
  }

  channel(id: string): ChannelRef | undefined {
    return this.channels.get(id);
  }

  message(channel: string, id: string): MessageData | undefined {
    const message = this.messages.get(channel)?.get(id);
    return message && !message.deleted && !message.hidden ? message : undefined;
  }

  lastMessageId(channel: string): string | undefined {
    return this.messages.get(channel)?.lastId();
  }

  /** Current heads of a server's state DAG (dependencies for new events). */
  heads(scope: string): string[] {
    const parsed = parseScope(scope);
    if (parsed?.kind === "server") return [...(this.servers.get(parsed.server)?.heads ?? [])];
    return [];
  }

  /** Event id of the message (used as a dependency for edits, reactions...). */
  messageEvent(channel: string, id: string): string | undefined {
    return this.messages.get(channel)?.get(id)?.event;
  }

  findUserByName(username: string, discriminator?: string, discriminatorOf?: (key: string) => string): ProfileData[] {
    return [...this.profiles.values()].filter(
      (p) =>
        p.username.toLowerCase() === username.toLowerCase() &&
        (!discriminator || !discriminatorOf || discriminatorOf(p.key) === discriminator),
    );
  }
}

/** Deterministic relationship state for a pair of users. */
export function foldRelations(users: [string, string], events: StoatEvent[]): Record<string, RelationshipStatus> {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  let pendingFrom: string | null = null;
  let friends = false;
  const blocked = new Set<string>();
  for (const event of sorted) {
    const x = event.author;
    const y = users[0] === x ? users[1] : users[0];
    switch (event.body.status) {
      case "request":
        if (blocked.size || friends) break;
        if (pendingFrom === y) {
          friends = true;
          pendingFrom = null;
        } else {
          pendingFrom = x;
        }
        break;
      case "accept":
        if (pendingFrom === y && !blocked.size) {
          friends = true;
          pendingFrom = null;
        }
        break;
      case "remove":
        friends = false;
        pendingFrom = null;
        break;
      case "block":
        blocked.add(x);
        friends = false;
        pendingFrom = null;
        break;
      case "unblock":
        blocked.delete(x);
        break;
    }
  }
  const status = (u: string): RelationshipStatus => {
    const other = users[0] === u ? users[1] : users[0];
    if (blocked.has(u)) return "Blocked";
    if (blocked.has(other)) return "BlockedOther";
    if (friends) return "Friend";
    if (pendingFrom === u) return "Outgoing";
    if (pendingFrom === other) return "Incoming";
    return "None";
  };
  return { [users[0]]: status(users[0]), [users[1]]: status(users[1]) };
}
