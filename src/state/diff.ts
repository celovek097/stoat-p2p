// Turn two server snapshots into the list of changes clients need to hear
// about. Used after incremental applies and after full re-folds alike.

import { canonical } from "../core/crypto.ts";
import type {
  EmojiData,
  MemberData,
  RoleData,
  ServerChannelData,
  ServerData,
  ServerSnapshot,
  SystemMessageData,
} from "./types.ts";

export type ServerChange =
  | { kind: "server.create" }
  | { kind: "server.update"; data: Partial<ServerData>; clear: string[] }
  | { kind: "server.delete" }
  | { kind: "channel.create"; channel: ServerChannelData }
  | { kind: "channel.update"; channel: ServerChannelData; data: Partial<ServerChannelData>; clear: string[] }
  | { kind: "channel.delete"; channel: string }
  | { kind: "role.update"; role: string; data: RoleData }
  | { kind: "role.delete"; role: string }
  | { kind: "member.join"; user: string; member: MemberData }
  | { kind: "member.leave"; user: string }
  | { kind: "member.update"; user: string; data: Partial<MemberData>; clear: string[] }
  | { kind: "emoji.create"; emoji: EmojiData }
  | { kind: "emoji.delete"; emoji: string }
  | { kind: "system.add"; message: SystemMessageData }
  | { kind: "system.remove"; message: SystemMessageData };

const same = (a: unknown, b: unknown) => a === b || canonical(a ?? null) === canonical(b ?? null);

function diffFields<T extends object>(
  before: T,
  after: T,
  names: Record<string, string>,
  ignore: string[] = [],
): { data: Partial<T>; clear: string[] } {
  const data: Record<string, unknown> = {};
  const clear: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (ignore.includes(key)) continue;
    const a = (before as Record<string, unknown>)[key];
    const b = (after as Record<string, unknown>)[key];
    if (same(a, b)) continue;
    if (b === undefined) {
      if (names[key]) clear.push(names[key]);
    } else {
      data[key] = b;
    }
  }
  return { data: data as Partial<T>, clear };
}

const SERVER_FIELDS = {
  description: "Description",
  icon: "Icon",
  banner: "Banner",
  categories: "Categories",
  system_messages: "SystemMessages",
};
const CHANNEL_FIELDS = { description: "Description", icon: "Icon", default_permissions: "DefaultPermissions", voice: "Voice" };
const MEMBER_FIELDS = { nickname: "Nickname", avatar: "Avatar", roles: "Roles", timeout: "Timeout", pronouns: "Pronouns" };

export function diffSnapshots(before: ServerSnapshot, after: ServerSnapshot): ServerChange[] {
  const changes: ServerChange[] = [];
  const a = before.server;
  const b = after.server;

  if (!b) return changes;
  if (!a && b && !b.deleted) {
    changes.push({ kind: "server.create" });
  } else if (a && !a.deleted && b.deleted) {
    changes.push({ kind: "server.delete" });
    return changes;
  } else if (a && b && !b.deleted) {
    const { data, clear } = diffFields(a, b, SERVER_FIELDS, ["roles", "deleted"]);
    if (Object.keys(data).length || clear.length) changes.push({ kind: "server.update", data, clear });

    for (const [id, role] of Object.entries(b.roles)) {
      if (!same(a.roles[id], role)) changes.push({ kind: "role.update", role: id, data: role });
    }
    for (const id of Object.keys(a.roles)) {
      if (!b.roles[id]) changes.push({ kind: "role.delete", role: id });
    }
  }
  if (b.deleted) return changes;
  const created = !a;

  for (const [id, channel] of Object.entries(after.channels)) {
    const old = before.channels[id];
    if (!old) {
      if (!created) changes.push({ kind: "channel.create", channel });
    } else if (!same(old, channel)) {
      const { data, clear } = diffFields(old, channel, CHANNEL_FIELDS);
      changes.push({ kind: "channel.update", channel, data, clear });
    }
  }
  for (const id of Object.keys(before.channels)) {
    if (!after.channels[id]) changes.push({ kind: "channel.delete", channel: id });
  }

  for (const [user, member] of Object.entries(after.members)) {
    const old = before.members[user];
    if (!old) {
      changes.push({ kind: "member.join", user, member });
    } else if (!same(old, member)) {
      const { data, clear } = diffFields(old, member, MEMBER_FIELDS, ["user", "joined_at"]);
      changes.push({ kind: "member.update", user, data, clear });
    }
  }
  for (const user of Object.keys(before.members)) {
    if (!after.members[user]) changes.push({ kind: "member.leave", user });
  }

  for (const [id, emoji] of Object.entries(after.emojis)) {
    if (!before.emojis[id]) changes.push({ kind: "emoji.create", emoji });
  }
  for (const id of Object.keys(before.emojis)) {
    if (!after.emojis[id]) changes.push({ kind: "emoji.delete", emoji: id });
  }

  const oldSystem = new Map(before.system.map((m) => [m.id, m]));
  const newSystem = new Map(after.system.map((m) => [m.id, m]));
  for (const [id, message] of newSystem) if (!oldSystem.has(id)) changes.push({ kind: "system.add", message });
  for (const [id, message] of oldSystem) if (!newSystem.has(id)) changes.push({ kind: "system.remove", message });

  return changes;
}
