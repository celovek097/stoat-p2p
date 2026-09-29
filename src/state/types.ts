import type { OverrideField } from "./permissions.ts";

/** Stoat "File" object. `_id` is the sha256 of the content (hex). */
export interface FileObject {
  _id: string;
  tag: string;
  filename: string;
  metadata:
    | { type: "File" }
    | { type: "Text" }
    | { type: "Audio" }
    | { type: "Image"; width: number; height: number }
    | { type: "Video"; width: number; height: number };
  content_type: string;
  size: number;
}

export interface Category {
  id: string;
  title: string;
  channels: string[];
}

export interface SystemMessageChannels {
  user_joined?: string;
  user_left?: string;
  user_kicked?: string;
  user_banned?: string;
}

export interface RoleData {
  name: string;
  permissions: OverrideField;
  colour?: string;
  hoist?: boolean;
  rank: number;
  icon?: FileObject;
}

export interface ServerData {
  id: string;
  owner: string;
  name: string;
  description?: string;
  channels: string[];
  categories?: Category[];
  system_messages?: SystemMessageChannels;
  roles: Record<string, RoleData>;
  default_permissions: number;
  icon?: FileObject;
  banner?: FileObject;
  flags: number;
  nsfw: boolean;
  deleted: boolean;
}

export interface ServerChannelData {
  id: string;
  server: string;
  kind: "Text" | "Voice";
  name: string;
  description?: string;
  icon?: FileObject;
  nsfw?: boolean;
  slowmode?: number;
  voice?: { max_users?: number };
  default_permissions?: OverrideField;
  role_permissions: Record<string, OverrideField>;
}

export interface MemberData {
  user: string;
  joined_at: number;
  nickname?: string;
  avatar?: FileObject;
  pronouns?: string;
  roles: string[];
  timeout?: number;
}

export interface InviteData {
  code: string;
  channel: string;
  creator: string;
  created: number;
}

export interface EmojiData {
  id: string;
  name: string;
  creator: string;
  file: FileObject;
  animated: boolean;
  nsfw: boolean;
}

export interface SystemMessageData {
  id: string;
  channel: string;
  ts: number;
  system: Record<string, unknown>;
}

export interface ServerSnapshot {
  server: ServerData | null;
  channels: Record<string, ServerChannelData>;
  members: Record<string, MemberData>;
  bans: Record<string, { reason?: string; ts: number }>;
  invites: Record<string, InviteData>;
  emojis: Record<string, EmojiData>;
  /** Membership intervals in fold positions: [joinedAt, leftAt | null] */
  memberships: Record<string, Array<[number, number | null]>>;
  system: SystemMessageData[];
}

export interface MessageData {
  id: string;
  channel: string;
  author: string;
  event: string;
  ts: number;
  nonce?: string;
  content?: string;
  attachments?: FileObject[];
  replies?: string[];
  mentions?: string[];
  role_mentions?: string[];
  masquerade?: Record<string, unknown>;
  embeds?: Array<Record<string, unknown>>;
  interactions?: Record<string, unknown>;
  flags?: number;
  system?: Record<string, unknown>;
  edited?: number;
  editKey?: string;
  pinned?: boolean;
  pinKey?: string;
  /** emoji -> user -> "ts:eventId:1|0" (last writer wins) */
  reactions: Record<string, Record<string, string>>;
  deleted?: boolean;
  /** Soft-failed: stored and forwarded but not shown to clients. */
  hidden?: boolean;
  encrypted?: boolean;
}

export interface ProfileData {
  user: string;
  key: string;
  ts: number;
  event: string;
  username: string;
  display_name?: string;
  avatar?: FileObject;
  status?: { text?: string; presence?: string };
  profile?: { content?: string; background?: FileObject };
  pronouns?: string;
  /** X25519 key for end-to-end encrypted DMs */
  x25519?: string;
  /** Addresses of the user's home node(s), used as peer hints */
  nodes?: string[];
}

export type RelationshipStatus = "None" | "User" | "Friend" | "Outgoing" | "Incoming" | "Blocked" | "BlockedOther";
