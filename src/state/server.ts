// Replicated state of a single Stoat server ("guild").
//
// State-changing events form a DAG through their `deps`. Every node orders
// the DAG the same way (depth, timestamp, id) and folds it from scratch, so
// two nodes holding the same set of events always compute the same server.
// Events that are not allowed at their position (missing permission, bad
// rank, ...) are kept but have no effect.

import { sha256 } from "../core/crypto.ts";
import { inviteCode, objectId, serverIdFrom, type StoatEvent } from "../core/event.ts";
import { isUlid, ulidFrom } from "../core/ulid.ts";
import {
  ALLOW_IN_TIMEOUT,
  applyOverride,
  DEFAULT_PERMISSION_SERVER,
  has,
  isPermissionValue,
  type OverrideField,
  Permission,
} from "./permissions.ts";
import type {
  Category,
  FileObject,
  MemberData,
  RoleData,
  ServerChannelData,
  ServerSnapshot,
  SystemMessageChannels,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Validation helpers (shared with the message layer)

export function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

export function isName(value: unknown, min: number, max: number): value is string {
  return isText(value, min, max) && value.trim().length >= min && !/[​\n\r]/.test(value);
}

const FILE_TAGS = new Set(["attachments", "avatars", "backgrounds", "icons", "banners", "emojis"]);

export function isFile(value: unknown, tag?: string): value is FileObject {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  if (typeof f._id !== "string" || !/^[0-9a-f]{64}$/.test(f._id)) return false;
  if (typeof f.tag !== "string" || !FILE_TAGS.has(f.tag) || (tag && f.tag !== tag)) return false;
  if (!isText(f.filename, 1, 256) || !isText(f.content_type, 1, 128)) return false;
  if (typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0) return false;
  const meta = f.metadata as Record<string, unknown> | undefined;
  if (typeof meta !== "object" || meta === null) return false;
  switch (meta.type) {
    case "File":
    case "Text":
    case "Audio":
      return true;
    case "Image":
    case "Video":
      return Number.isSafeInteger(meta.width) && Number.isSafeInteger(meta.height);
    default:
      return false;
  }
}

const RE_COLOUR =
  /^(?:[a-z ]+|var\(--[a-z\d-]+\)|rgba?\([\d, ]+\)|#[a-f0-9]+|(repeating-)?(linear|conic|radial)-gradient\(([a-z ]+|var\(--[a-z\d-]+\)|rgba?\([\d, ]+\)|#[a-f0-9]+|\d+deg)([ ]+in[ ]+[a-z-]+([ ]+(shorter|longer|increasing|decreasing)[ ]+hue)?)?([ ]+(\d{1,3}%|0))?(,[ ]*([a-z ]+|var\(--[a-z\d-]+\)|rgba?\([\d, ]+\)|#[a-f0-9]+)([ ]+(\d{1,3}%|0))?)+\))$/i;

export function isColour(value: unknown): value is string {
  return isText(value, 1, 128) && RE_COLOUR.test(value);
}

function isOverride(value: unknown): value is { allow: number; deny: number } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isPermissionValue(v.allow) && isPermissionValue(v.deny);
}

function toField(value: { allow: number; deny: number }): OverrideField {
  return { a: value.allow, d: value.deny };
}

/** You may only change permission bits that you hold yourself. */
function canChangeOverride(own: bigint, current: OverrideField | undefined, next: OverrideField): boolean {
  const cur = current ?? { a: 0, d: 0 };
  const changed = (BigInt(cur.a) ^ BigInt(next.a)) | (BigInt(cur.d) ^ BigInt(next.d));
  return (changed & ~own) === 0n;
}

// ---------------------------------------------------------------------------
// Permission calculation against a snapshot

export function emptySnapshot(): ServerSnapshot {
  return { server: null, channels: {}, members: {}, bans: {}, invites: {}, emojis: {}, memberships: {}, system: [] };
}

function orderedRoles(snap: ServerSnapshot, member: MemberData): Array<[string, RoleData]> {
  const roles = snap.server?.roles ?? {};
  return member.roles
    .filter((id) => roles[id])
    .map((id) => [id, roles[id]!] as [string, RoleData])
    .sort((a, b) => b[1].rank - a[1].rank);
}

export function serverPermissions(snap: ServerSnapshot, user: string, now = Date.now()): bigint {
  const server = snap.server;
  if (!server || server.deleted) return 0n;
  if (server.owner === user) return Permission.GrantAllSafe;
  const member = snap.members[user];
  if (!member) return 0n;
  let value = BigInt(server.default_permissions);
  for (const [, role] of orderedRoles(snap, member)) value = applyOverride(value, role.permissions);
  if (member.timeout && member.timeout > now) value &= ALLOW_IN_TIMEOUT;
  return value;
}

export function channelPermissions(snap: ServerSnapshot, channelId: string, user: string, now = Date.now()): bigint {
  const server = snap.server;
  const channel = snap.channels[channelId];
  if (!server || server.deleted || !channel) return 0n;
  if (server.owner === user) return Permission.GrantAllSafe;
  const member = snap.members[user];
  if (!member) return 0n;
  const roles = orderedRoles(snap, member);
  let value = applyOverride(BigInt(server.default_permissions), channel.default_permissions);
  for (const [, role] of roles) value = applyOverride(value, role.permissions);
  for (const [id] of roles) value = applyOverride(value, channel.role_permissions[id]);
  if (member.timeout && member.timeout > now) value &= ALLOW_IN_TIMEOUT;
  if (!has(value, Permission.ViewChannel)) value = 0n;
  return value;
}

/** Lower is more powerful. The owner outranks everyone. */
export function memberRank(snap: ServerSnapshot, user: string): number {
  if (snap.server?.owner === user) return Number.NEGATIVE_INFINITY;
  const member = snap.members[user];
  let rank = Number.MAX_SAFE_INTEGER;
  for (const id of member?.roles ?? []) {
    const role = snap.server?.roles[id];
    if (role && role.rank < rank) rank = role.rank;
  }
  return rank;
}

// ---------------------------------------------------------------------------
// The fold

function openMembership(snap: ServerSnapshot, user: string, pos: number): void {
  (snap.memberships[user] ??= []).push([pos, null]);
}

function closeMembership(snap: ServerSnapshot, user: string, pos: number): void {
  const intervals = snap.memberships[user];
  const last = intervals?.[intervals.length - 1];
  if (last && last[1] === null) last[1] = pos;
}

function removeMember(snap: ServerSnapshot, user: string, pos: number): void {
  delete snap.members[user];
  closeMembership(snap, user, pos);
}

function systemMessage(
  snap: ServerSnapshot,
  event: StoatEvent,
  slot: keyof SystemMessageChannels,
  system: Record<string, unknown>,
): void {
  const channel = snap.server?.system_messages?.[slot];
  if (channel && snap.channels[channel]) {
    snap.system.push({ id: objectId(event), channel, ts: event.ts, system });
  }
}

function channelIdFromGenesis(genesis: StoatEvent, index: number): string {
  return ulidFrom(genesis.ts, sha256(`${genesis.id}/channel/${index}`));
}

type Body = Record<string, unknown>;

const SERVER_CLEARABLE: Record<string, "description" | "icon" | "banner" | "categories" | "system_messages"> = {
  Description: "description",
  Icon: "icon",
  Banner: "banner",
  Categories: "categories",
  SystemMessages: "system_messages",
};

function validCategories(snap: ServerSnapshot, value: unknown): value is Category[] {
  if (!Array.isArray(value) || value.length > 50) return false;
  const ids = new Set<string>();
  for (const category of value) {
    if (typeof category !== "object" || category === null) return false;
    const c = category as Record<string, unknown>;
    if (!isText(c.id, 1, 32) || !isName(c.title, 1, 32) || ids.has(c.id)) return false;
    ids.add(c.id);
    if (!Array.isArray(c.channels) || !c.channels.every((id) => typeof id === "string" && snap.channels[id])) {
      return false;
    }
  }
  return true;
}

function validSystemMessages(snap: ServerSnapshot, value: unknown): value is SystemMessageChannels {
  if (typeof value !== "object" || value === null) return false;
  for (const [key, channel] of Object.entries(value)) {
    if (!["user_joined", "user_left", "user_kicked", "user_banned"].includes(key)) return false;
    if (channel !== undefined && channel !== null && !(typeof channel === "string" && snap.channels[channel])) {
      return false;
    }
  }
  return true;
}

/**
 * Apply one state event to the snapshot. Returns false (and leaves the
 * snapshot untouched) when the event is not allowed at this point.
 */
export function applyStateEvent(snap: ServerSnapshot, event: StoatEvent, pos: number, serverId: string): boolean {
  const body = event.body as Body;
  const author = event.author;

  if (event.type === "server.create") {
    if (snap.server) return false;
    if (!isText(body.nonce, 1, 64) || serverIdFrom(event.ts, event.key, body.nonce) !== serverId) return false;
    if (!isName(body.name, 1, 32)) return false;
    if (body.description !== undefined && !isText(body.description, 0, 1024)) return false;
    const initial = Array.isArray(body.channels) ? body.channels : [];
    if (initial.length > 10) return false;
    snap.server = {
      id: serverId,
      owner: author,
      name: body.name,
      description: body.description as string | undefined,
      channels: [],
      roles: {},
      default_permissions: Number(DEFAULT_PERMISSION_SERVER),
      flags: 0,
      nsfw: body.nsfw === true,
      deleted: false,
    };
    initial.forEach((raw, index) => {
      const c = raw as Body;
      if (!isName(c?.name, 1, 32)) return;
      const id = channelIdFromGenesis(event, index);
      snap.channels[id] = {
        id,
        server: serverId,
        kind: c.type === "Voice" ? "Voice" : "Text",
        name: c.name,
        role_permissions: {},
      };
      snap.server!.channels.push(id);
    });
    const first = snap.server.channels[0];
    if (first && body.system_messages === true) {
      snap.server.system_messages = { user_joined: first, user_left: first, user_kicked: first, user_banned: first };
    }
    snap.members[author] = { user: author, joined_at: event.ts, roles: [] };
    openMembership(snap, author, pos);
    return true;
  }

  const server = snap.server;
  if (!server || server.deleted) return false;
  const isOwner = server.owner === author;
  const member = snap.members[author];
  if (!member && event.type !== "member.join") return false;
  const now = event.ts;
  const perms = () => serverPermissions(snap, author, now);
  const rank = memberRank(snap, author);

  switch (event.type) {
    case "server.update": {
      const p = perms();
      const next = { ...server };
      const touchesServer = ["name", "description", "icon", "banner", "system_messages", "nsfw"].some(
        (key) => body[key] !== undefined,
      );
      const remove = Array.isArray(body.remove) ? (body.remove as string[]) : [];
      if (!remove.every((field) => SERVER_CLEARABLE[field])) return false;
      if ((touchesServer || remove.some((f) => f !== "Categories")) && !has(p, Permission.ManageServer)) return false;
      if ((body.categories !== undefined || remove.includes("Categories")) && !has(p, Permission.ManageChannel)) {
        return false;
      }
      for (const field of remove) delete next[SERVER_CLEARABLE[field]!];
      if (body.name !== undefined) {
        if (!isName(body.name, 1, 32)) return false;
        next.name = body.name;
      }
      if (body.description !== undefined) {
        if (!isText(body.description, 0, 1024)) return false;
        next.description = body.description;
      }
      if (body.icon !== undefined) {
        if (!isFile(body.icon, "icons")) return false;
        next.icon = body.icon;
      }
      if (body.banner !== undefined) {
        if (!isFile(body.banner, "banners")) return false;
        next.banner = body.banner;
      }
      if (body.nsfw !== undefined) {
        if (typeof body.nsfw !== "boolean") return false;
        next.nsfw = body.nsfw;
      }
      if (body.categories !== undefined) {
        if (!validCategories(snap, body.categories)) return false;
        next.categories = body.categories;
      }
      if (body.system_messages !== undefined) {
        if (!validSystemMessages(snap, body.system_messages)) return false;
        next.system_messages = Object.fromEntries(
          Object.entries(body.system_messages as Body).filter(([, v]) => typeof v === "string"),
        ) as SystemMessageChannels;
      }
      if (body.owner !== undefined) {
        if (!isOwner || typeof body.owner !== "string" || !snap.members[body.owner]) return false;
        next.owner = body.owner;
      }
      snap.server = next;
      return true;
    }

    case "server.delete": {
      if (!isOwner) return false;
      server.deleted = true;
      return true;
    }

    case "server.permissions": {
      const p = perms();
      if (!has(p, Permission.ManagePermissions)) return false;
      if (body.role === "default") {
        if (!isPermissionValue(body.permissions)) return false;
        const changed = BigInt(server.default_permissions) ^ BigInt(body.permissions);
        if (!isOwner && (changed & ~p) !== 0n) return false;
        server.default_permissions = body.permissions;
        return true;
      }
      const role = typeof body.role === "string" ? server.roles[body.role] : undefined;
      if (!role || !isOverride(body.permissions)) return false;
      if (!isOwner && role.rank <= rank) return false;
      const next = toField(body.permissions);
      if (!isOwner && !canChangeOverride(p, role.permissions, next)) return false;
      server.roles[body.role as string] = { ...role, permissions: next };
      return true;
    }

    case "channel.create": {
      if (!has(perms(), Permission.ManageChannel)) return false;
      if (server.channels.length >= 200) return false;
      if (!isName(body.name, 1, 32)) return false;
      if (body.description !== undefined && !isText(body.description, 0, 1024)) return false;
      const id = objectId(event);
      if (snap.channels[id]) return false;
      snap.channels[id] = {
        id,
        server: serverId,
        kind: body.type === "Voice" ? "Voice" : "Text",
        name: body.name,
        description: body.description as string | undefined,
        nsfw: body.nsfw === true ? true : undefined,
        role_permissions: {},
      };
      server.channels.push(id);
      return true;
    }

    case "channel.update": {
      const channelId = body.channel as string;
      const channel = snap.channels[channelId];
      if (!channel) return false;
      if (!has(channelPermissions(snap, channelId, author, now), Permission.ManageChannel)) return false;
      const next: ServerChannelData = { ...channel };
      const remove = Array.isArray(body.remove) ? (body.remove as string[]) : [];
      for (const field of remove) {
        if (field === "Description") delete next.description;
        else if (field === "Icon") delete next.icon;
        else if (field === "Voice") delete next.voice;
        else if (field === "DefaultPermissions") delete next.default_permissions;
        else return false;
      }
      if (body.name !== undefined) {
        if (!isName(body.name, 1, 32)) return false;
        next.name = body.name;
      }
      if (body.description !== undefined) {
        if (!isText(body.description, 0, 1024)) return false;
        next.description = body.description;
      }
      if (body.icon !== undefined) {
        if (!isFile(body.icon, "icons")) return false;
        next.icon = body.icon;
      }
      if (body.nsfw !== undefined) {
        if (typeof body.nsfw !== "boolean") return false;
        next.nsfw = body.nsfw || undefined;
      }
      if (body.slowmode !== undefined) {
        if (!Number.isSafeInteger(body.slowmode) || (body.slowmode as number) < 0 || (body.slowmode as number) > 21600) {
          return false;
        }
        next.slowmode = (body.slowmode as number) || undefined;
      }
      snap.channels[channelId] = next;
      return true;
    }

    case "channel.delete": {
      const channelId = body.channel as string;
      if (!snap.channels[channelId]) return false;
      if (!has(channelPermissions(snap, channelId, author, now), Permission.ManageChannel)) return false;
      delete snap.channels[channelId];
      server.channels = server.channels.filter((id) => id !== channelId);
      if (server.categories) {
        server.categories = server.categories.map((c) => ({ ...c, channels: c.channels.filter((id) => id !== channelId) }));
      }
      if (server.system_messages) {
        const sm = { ...server.system_messages };
        for (const key of Object.keys(sm) as Array<keyof SystemMessageChannels>) {
          if (sm[key] === channelId) delete sm[key];
        }
        server.system_messages = sm;
      }
      for (const [code, invite] of Object.entries(snap.invites)) {
        if (invite.channel === channelId) delete snap.invites[code];
      }
      return true;
    }

    case "channel.permissions": {
      const channelId = body.channel as string;
      const channel = snap.channels[channelId];
      if (!channel || !isOverride(body.permissions)) return false;
      const p = channelPermissions(snap, channelId, author, now);
      if (!has(p, Permission.ManagePermissions)) return false;
      const next = toField(body.permissions);
      if (body.role === "default") {
        if (!isOwner && !canChangeOverride(p, channel.default_permissions, next)) return false;
        snap.channels[channelId] = { ...channel, default_permissions: next };
        return true;
      }
      const role = typeof body.role === "string" ? server.roles[body.role] : undefined;
      if (!role) return false;
      if (!isOwner && role.rank <= rank) return false;
      if (!isOwner && !canChangeOverride(p, channel.role_permissions[body.role as string], next)) return false;
      snap.channels[channelId] = {
        ...channel,
        role_permissions: { ...channel.role_permissions, [body.role as string]: next },
      };
      return true;
    }

    case "role.create": {
      if (!has(perms(), Permission.ManageRole)) return false;
      if (!isName(body.name, 1, 32) || Object.keys(server.roles).length >= 200) return false;
      const ranks = Object.values(server.roles).map((r) => r.rank);
      let roleRank = ranks.length ? Math.max(...ranks) + 1 : 0;
      if (body.rank !== undefined) {
        if (!Number.isSafeInteger(body.rank)) return false;
        if (!isOwner && (body.rank as number) <= rank) return false;
        roleRank = body.rank as number;
      }
      const id = objectId(event);
      server.roles[id] = { name: body.name, permissions: { a: 0, d: 0 }, rank: roleRank };
      return true;
    }

    case "role.update": {
      const roleId = body.role as string;
      const role = server.roles[roleId];
      if (!role || !has(perms(), Permission.ManageRole)) return false;
      if (!isOwner && role.rank <= rank) return false;
      const next: RoleData = { ...role };
      const remove = Array.isArray(body.remove) ? (body.remove as string[]) : [];
      for (const field of remove) {
        if (field === "Colour") delete next.colour;
        else if (field === "Icon") delete next.icon;
        else return false;
      }
      if (body.name !== undefined) {
        if (!isName(body.name, 1, 32)) return false;
        next.name = body.name;
      }
      if (body.colour !== undefined) {
        if (!isColour(body.colour)) return false;
        next.colour = body.colour;
      }
      if (body.hoist !== undefined) {
        if (typeof body.hoist !== "boolean") return false;
        next.hoist = body.hoist;
      }
      if (body.icon !== undefined) {
        if (!isFile(body.icon, "icons")) return false;
        next.icon = body.icon;
      }
      if (body.rank !== undefined) {
        if (!Number.isSafeInteger(body.rank)) return false;
        if (!isOwner && (body.rank as number) <= rank) return false;
        next.rank = body.rank as number;
      }
      server.roles[roleId] = next;
      return true;
    }

    case "role.delete": {
      const roleId = body.role as string;
      const role = server.roles[roleId];
      if (!role || !has(perms(), Permission.ManageRole)) return false;
      if (!isOwner && role.rank <= rank) return false;
      delete server.roles[roleId];
      for (const [user, m] of Object.entries(snap.members)) {
        if (m.roles.includes(roleId)) snap.members[user] = { ...m, roles: m.roles.filter((r) => r !== roleId) };
      }
      for (const [id, channel] of Object.entries(snap.channels)) {
        if (channel.role_permissions[roleId]) {
          const role_permissions = { ...channel.role_permissions };
          delete role_permissions[roleId];
          snap.channels[id] = { ...channel, role_permissions };
        }
      }
      return true;
    }

    case "role.ranks": {
      if (!has(perms(), Permission.ManageRole)) return false;
      const ranks = body.ranks;
      const ids = Object.keys(server.roles);
      if (!Array.isArray(ranks) || ranks.length !== ids.length || !ids.every((id) => ranks.includes(id))) return false;
      if (!isOwner) {
        // Roles at or above our own rank must keep their position.
        for (const id of ids) {
          const role = server.roles[id]!;
          if (role.rank <= rank && ranks.indexOf(id) !== role.rank) return false;
        }
      }
      ranks.forEach((id: string, index: number) => {
        server.roles[id] = { ...server.roles[id]!, rank: index };
      });
      return true;
    }

    case "member.join": {
      if (member || snap.bans[author]) return false;
      const invite = typeof body.invite === "string" ? snap.invites[body.invite] : undefined;
      if (!invite || !snap.channels[invite.channel]) return false;
      snap.members[author] = { user: author, joined_at: event.ts, roles: [] };
      openMembership(snap, author, pos);
      systemMessage(snap, event, "user_joined", { type: "user_joined", id: author });
      return true;
    }

    case "member.leave": {
      if (isOwner) return false;
      removeMember(snap, author, pos);
      systemMessage(snap, event, "user_left", { type: "user_left", id: author });
      return true;
    }

    case "member.kick": {
      const target = body.user as string;
      if (!snap.members[target] || target === server.owner || target === author) return false;
      if (!has(perms(), Permission.KickMembers)) return false;
      if (!isOwner && memberRank(snap, target) <= rank) return false;
      removeMember(snap, target, pos);
      systemMessage(snap, event, "user_kicked", { type: "user_kicked", id: target });
      return true;
    }

    case "member.edit": {
      const target = body.user as string;
      const current = snap.members[target];
      if (!current) return false;
      const self = target === author;
      const p = perms();
      const outranks = isOwner || memberRank(snap, target) > rank;
      const next: MemberData = { ...current };
      const remove = Array.isArray(body.remove) ? (body.remove as string[]) : [];
      const nameAllowed = self ? has(p, Permission.ChangeNickname) : has(p, Permission.ManageNicknames) && outranks;
      for (const field of remove) {
        if (field === "Nickname" || field === "Pronouns") {
          if (!nameAllowed) return false;
          delete next[field === "Nickname" ? "nickname" : "pronouns"];
        } else if (field === "Avatar") {
          if (self ? !has(p, Permission.ChangeAvatar) : !(has(p, Permission.RemoveAvatars) && outranks)) return false;
          delete next.avatar;
        } else if (field === "Roles") {
          if (!has(p, Permission.AssignRoles) || (!self && !outranks)) return false;
          if (!isOwner && current.roles.some((id) => (server.roles[id]?.rank ?? Infinity) <= rank)) return false;
          next.roles = [];
        } else if (field === "Timeout") {
          if (self || !has(p, Permission.TimeoutMembers) || !outranks) return false;
          delete next.timeout;
        } else {
          return false;
        }
      }
      if (body.nickname !== undefined) {
        if (!nameAllowed || !isName(body.nickname, 1, 32)) return false;
        next.nickname = body.nickname;
      }
      if (body.pronouns !== undefined) {
        if (!nameAllowed || !isName(body.pronouns, 1, 24)) return false;
        next.pronouns = body.pronouns;
      }
      if (body.avatar !== undefined) {
        if (!self || !has(p, Permission.ChangeAvatar) || !isFile(body.avatar, "avatars")) return false;
        next.avatar = body.avatar;
      }
      if (body.roles !== undefined) {
        if (!Array.isArray(body.roles) || !body.roles.every((id) => typeof id === "string" && server.roles[id])) {
          return false;
        }
        if (!has(p, Permission.AssignRoles) || (!self && !outranks)) return false;
        const roles = [...new Set(body.roles as string[])];
        const changed = [
          ...roles.filter((id) => !current.roles.includes(id)),
          ...current.roles.filter((id) => !roles.includes(id)),
        ];
        if (!isOwner && changed.some((id) => (server.roles[id]?.rank ?? -Infinity) <= rank)) return false;
        next.roles = roles;
      }
      if (body.timeout !== undefined) {
        if (self || target === server.owner || !has(p, Permission.TimeoutMembers) || !outranks) return false;
        if (!Number.isSafeInteger(body.timeout)) return false;
        next.timeout = body.timeout as number;
      }
      snap.members[target] = next;
      return true;
    }

    case "ban.create": {
      const target = body.user as string;
      if (!isUlid(target) || target === server.owner || target === author || snap.bans[target]) return false;
      if (!has(perms(), Permission.BanMembers)) return false;
      if (snap.members[target] && !isOwner && memberRank(snap, target) <= rank) return false;
      if (body.reason !== undefined && !isText(body.reason, 0, 1024)) return false;
      snap.bans[target] = { reason: body.reason as string | undefined, ts: event.ts };
      if (snap.members[target]) removeMember(snap, target, pos);
      systemMessage(snap, event, "user_banned", { type: "user_banned", id: target });
      return true;
    }

    case "ban.remove": {
      const target = body.user as string;
      if (!snap.bans[target] || !has(perms(), Permission.BanMembers)) return false;
      delete snap.bans[target];
      return true;
    }

    case "invite.create": {
      const channelId = body.channel as string;
      if (!snap.channels[channelId]) return false;
      if (!has(channelPermissions(snap, channelId, author, now), Permission.InviteOthers)) return false;
      const code = inviteCode(event);
      snap.invites[code] = { code, channel: channelId, creator: author, created: event.ts };
      return true;
    }

    case "invite.delete": {
      const invite = snap.invites[body.code as string];
      if (!invite) return false;
      if (invite.creator !== author && !has(perms(), Permission.ManageServer)) return false;
      delete snap.invites[invite.code];
      return true;
    }

    case "emoji.create": {
      if (!has(perms(), Permission.ManageCustomisation)) return false;
      if (!isText(body.name, 1, 32) || !/^[a-z0-9_]+$/.test(body.name) || !isFile(body.file, "emojis")) return false;
      if (Object.keys(snap.emojis).length >= 100) return false;
      const id = objectId(event);
      snap.emojis[id] = {
        id,
        name: body.name,
        creator: author,
        file: body.file,
        animated: body.file.content_type === "image/gif",
        nsfw: body.nsfw === true,
      };
      return true;
    }

    case "emoji.delete": {
      const emoji = snap.emojis[body.emoji as string];
      if (!emoji) return false;
      if (emoji.creator !== author && !has(perms(), Permission.ManageCustomisation)) return false;
      delete snap.emojis[emoji.id];
      return true;
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// DAG bookkeeping

interface Placed {
  event: StoatEvent;
  depth: number;
}

function compare(a: Placed, b: Placed): number {
  return a.depth - b.depth || a.event.ts - b.event.ts || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0);
}

export class ServerState {
  readonly id: string;
  readonly scope: string;
  snap: ServerSnapshot = emptySnapshot();
  /** State events that no other state event depends on. */
  readonly heads = new Set<string>();
  /** Authors of every create/join event in the DAG (used to drop spam from strangers). */
  readonly joinAuthors = new Set<string>();
  /** Set while events were inserted out of order and a re-fold is pending. */
  dirty = false;

  readonly #placed = new Map<string, Placed>();
  #order: Placed[] = [];
  readonly #positions = new Map<string, number>();
  readonly #applied = new Set<string>();

  constructor(id: string) {
    this.id = id;
    this.scope = `server:${id}`;
  }

  has(id: string): boolean {
    return this.#placed.has(id);
  }

  get size(): number {
    return this.#placed.size;
  }

  get genesis(): StoatEvent | undefined {
    return this.#order[0]?.event.type === "server.create" ? this.#order[0].event : undefined;
  }

  /** Whether the event had an effect in the current fold. */
  applied(id: string): boolean {
    return this.#applied.has(id);
  }

  position(id: string): number | undefined {
    return this.#positions.get(id);
  }

  /** Highest fold position among the given dependencies (-1 when none). */
  depPosition(deps: string[]): number {
    let pos = -1;
    for (const dep of deps) {
      const p = this.#positions.get(dep);
      if (p !== undefined && p > pos) pos = p;
    }
    return pos;
  }

  /** Whether `user` was a member at fold position `pos`. */
  memberAt(user: string, pos: number): boolean {
    return (this.snap.memberships[user] ?? []).some(([from, to]) => from <= pos && (to === null || pos < to));
  }

  add(event: StoatEvent, deferRefold = false): void {
    if (this.#placed.has(event.id)) return;
    let depth = 0;
    for (const dep of event.deps) {
      const placed = this.#placed.get(dep);
      if (placed && placed.depth + 1 > depth) depth = placed.depth + 1;
    }
    const placed = { event, depth };
    this.#placed.set(event.id, placed);
    this.heads.add(event.id);
    for (const dep of event.deps) this.heads.delete(dep);
    if (event.type === "member.join" || event.type === "server.create") this.joinAuthors.add(event.author);

    const last = this.#order[this.#order.length - 1];
    if (!this.dirty && (!last || compare(placed, last) > 0)) {
      this.#order.push(placed);
      const pos = this.#order.length - 1;
      this.#positions.set(event.id, pos);
      this.#apply(placed, pos);
    } else {
      this.#order.push(placed);
      this.dirty = true;
      if (!deferRefold) this.refold();
    }
  }

  /** Recompute the whole state from the ordered DAG. */
  refold(): void {
    this.#order.sort(compare);
    this.#positions.clear();
    this.#applied.clear();
    this.snap = emptySnapshot();
    this.#order.forEach((placed, pos) => {
      this.#positions.set(placed.event.id, pos);
      this.#apply(placed, pos);
    });
    this.dirty = false;
  }

  #apply(placed: Placed, pos: number): void {
    if (applyStateEvent(this.snap, placed.event, pos, this.id)) this.#applied.add(placed.event.id);
  }
}
