// Conversion from internal state to the JSON objects of the Stoat API
// (see stoat-api/OpenAPI.json). Field names follow Stoat exactly.

import { discriminatorFor, savedChannelId } from "../core/event.ts";
import { SYSTEM_USER_ID } from "../core/ulid.ts";
import type { ServerState } from "../state/server.ts";
import type {
  EmojiData,
  InviteData,
  MemberData,
  MessageData,
  ProfileData,
  RoleData,
  ServerChannelData,
} from "../state/types.ts";
import type { ChannelRef, World } from "../state/world.ts";

export type Json = Record<string, unknown>;

export interface SerializerContext {
  world: World;
  isOnline(user: string): boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class Serializer {
  readonly #ctx: SerializerContext;

  constructor(ctx: SerializerContext) {
    this.#ctx = ctx;
  }

  get #world(): World {
    return this.#ctx.world;
  }

  // Users --------------------------------------------------------------------

  profileFields(profile: ProfileData): Json {
    const out: Json = {
      username: profile.username,
      discriminator: discriminatorFor(profile.key),
    };
    if (profile.display_name) out.display_name = profile.display_name;
    if (profile.avatar) out.avatar = profile.avatar;
    if (profile.pronouns) out.pronouns = profile.pronouns;
    if (profile.status && (profile.status.text || profile.status.presence)) out.status = profile.status;
    return out;
  }

  user(id: string, viewer: string): Json {
    const profile = this.#world.profiles.get(id);
    const relationship = this.#world.relationship(viewer, id);
    const base: Json = profile
      ? this.profileFields(profile)
      : { username: id === SYSTEM_USER_ID ? "System" : `user-${id.slice(-6).toLowerCase()}`, discriminator: "0000" };
    const user: Json = { _id: id, ...base, relationship, online: this.#ctx.isOnline(id) };
    if (id === viewer) {
      const relations = this.relationsOf(viewer);
      if (relations.length) user.relations = relations;
    }
    return user;
  }

  relationsOf(user: string): Json[] {
    const out: Json[] = [];
    for (const dm of this.#world.dmsOf(user)) {
      const status = dm.statuses[user];
      if (status && status !== "None") {
        const other = dm.users[0] === user ? dm.users[1] : dm.users[0];
        out.push({ _id: other, status });
      }
    }
    return out;
  }

  profile(id: string): Json {
    const profile = this.#world.profiles.get(id)?.profile;
    const out: Json = {};
    if (profile?.content) out.content = profile.content;
    if (profile?.background) out.background = profile.background;
    return out;
  }

  // Servers ------------------------------------------------------------------

  role(role: RoleData): Json {
    const out: Json = { name: role.name, permissions: role.permissions, rank: role.rank };
    if (role.colour) out.colour = role.colour;
    if (role.hoist) out.hoist = true;
    if (role.icon) out.icon = role.icon;
    return out;
  }

  server(state: ServerState): Json {
    const s = state.snap.server!;
    const out: Json = {
      _id: s.id,
      owner: s.owner,
      name: s.name,
      channels: s.channels,
      default_permissions: s.default_permissions,
      approximate_member_count: Object.keys(state.snap.members).length,
    };
    if (s.description) out.description = s.description;
    if (s.categories) out.categories = s.categories;
    if (s.system_messages) out.system_messages = s.system_messages;
    const roles = Object.entries(s.roles);
    if (roles.length) out.roles = Object.fromEntries(roles.map(([id, role]) => [id, { _id: id, ...this.role(role) }]));
    if (s.icon) out.icon = s.icon;
    if (s.banner) out.banner = s.banner;
    if (s.flags) out.flags = s.flags;
    if (s.nsfw) out.nsfw = true;
    return out;
  }

  /** Partial server/channel/member data from a diff, renamed for the API. */
  serverData(data: Json): Json {
    const out: Json = { ...data };
    delete out.id;
    delete out.deleted;
    return out;
  }

  serverChannel(channel: ServerChannelData): Json {
    const out: Json = {
      channel_type: "TextChannel",
      _id: channel.id,
      server: channel.server,
      name: channel.name,
    };
    if (channel.description) out.description = channel.description;
    if (channel.icon) out.icon = channel.icon;
    const last = this.#world.lastMessageId(channel.id);
    if (last) out.last_message_id = last;
    if (channel.default_permissions) out.default_permissions = channel.default_permissions;
    if (Object.keys(channel.role_permissions).length) out.role_permissions = channel.role_permissions;
    if (channel.nsfw) out.nsfw = true;
    if (channel.kind === "Voice") out.voice = channel.voice ?? {};
    if (channel.slowmode) out.slowmode = channel.slowmode;
    return out;
  }

  channelData(data: Partial<ServerChannelData>): Json {
    const out: Json = { ...data };
    delete out.id;
    delete out.server;
    if ("kind" in out) {
      if (out.kind === "Voice") out.voice = {};
      delete out.kind;
    }
    return out;
  }

  channel(ref: ChannelRef): Json | undefined {
    switch (ref.kind) {
      case "server": {
        const channel = this.#world.server(ref.server)?.snap.channels[ref.channel];
        return channel && this.serverChannel(channel);
      }
      case "dm": {
        const out: Json = { channel_type: "DirectMessage", _id: ref.channel, active: true, recipients: ref.users };
        const last = this.#world.lastMessageId(ref.channel);
        if (last) out.last_message_id = last;
        return out;
      }
      case "saved":
        return { channel_type: "SavedMessages", _id: ref.channel, user: ref.user };
    }
  }

  savedMessages(user: string): Json {
    return { channel_type: "SavedMessages", _id: savedChannelId(user), user };
  }

  member(server: string, member: MemberData): Json {
    const out: Json = { _id: { server, user: member.user }, joined_at: iso(member.joined_at) };
    if (member.nickname) out.nickname = member.nickname;
    if (member.avatar) out.avatar = member.avatar;
    if (member.pronouns) out.pronouns = member.pronouns;
    if (member.roles.length) out.roles = member.roles;
    if (member.timeout && member.timeout > Date.now()) out.timeout = iso(member.timeout);
    return out;
  }

  memberData(data: Partial<MemberData>): Json {
    const out: Json = { ...data };
    if (typeof data.timeout === "number") out.timeout = iso(data.timeout);
    delete out.user;
    delete out.joined_at;
    return out;
  }

  emoji(server: string, emoji: EmojiData): Json {
    return {
      _id: emoji.id,
      parent: { type: "Server", id: server },
      creator_id: emoji.creator,
      name: emoji.name,
      animated: emoji.animated,
      nsfw: emoji.nsfw,
    };
  }

  invite(server: string, invite: InviteData): Json {
    return { type: "Server", _id: invite.code, server, creator: invite.creator, channel: invite.channel };
  }

  // Messages -----------------------------------------------------------------

  message(message: MessageData): Json {
    const out: Json = { _id: message.id, channel: message.channel, author: message.author };
    if (message.nonce) out.nonce = message.nonce;
    if (message.content !== undefined) out.content = message.content;
    if (message.system) out.system = message.system;
    if (message.attachments) out.attachments = message.attachments;
    if (message.edited) out.edited = iso(message.edited);
    if (message.embeds) out.embeds = message.embeds;
    if (message.mentions?.length) out.mentions = message.mentions;
    if (message.role_mentions?.length) out.role_mentions = message.role_mentions;
    if (message.replies) out.replies = message.replies;
    if (message.masquerade) out.masquerade = message.masquerade;
    if (message.interactions) out.interactions = message.interactions;
    if (message.pinned) out.pinned = true;
    if (message.flags) out.flags = message.flags;
    const reactions: Record<string, string[]> = {};
    for (const [emoji, users] of Object.entries(message.reactions)) {
      const on = Object.entries(users)
        .filter(([, value]) => value.endsWith(":1"))
        .map(([user]) => user);
      if (on.length) reactions[emoji] = on;
    }
    if (Object.keys(reactions).length) out.reactions = reactions;
    return out;
  }
}
