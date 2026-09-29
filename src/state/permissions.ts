// Port of Stoat's permission model (crates/core/permissions).
// Values are kept as bigint internally; Stoat limits them to 52 bits so they
// fit into JSON numbers on the wire.

export const Permission = {
  ManageChannel: 1n << 0n,
  ManageServer: 1n << 1n,
  ManagePermissions: 1n << 2n,
  ManageRole: 1n << 3n,
  ManageCustomisation: 1n << 4n,
  KickMembers: 1n << 6n,
  BanMembers: 1n << 7n,
  TimeoutMembers: 1n << 8n,
  AssignRoles: 1n << 9n,
  ChangeNickname: 1n << 10n,
  ManageNicknames: 1n << 11n,
  ChangeAvatar: 1n << 12n,
  RemoveAvatars: 1n << 13n,
  ViewChannel: 1n << 20n,
  ReadMessageHistory: 1n << 21n,
  SendMessage: 1n << 22n,
  ManageMessages: 1n << 23n,
  ManageWebhooks: 1n << 24n,
  InviteOthers: 1n << 25n,
  SendEmbeds: 1n << 26n,
  UploadFiles: 1n << 27n,
  Masquerade: 1n << 28n,
  React: 1n << 29n,
  Connect: 1n << 30n,
  Speak: 1n << 31n,
  Video: 1n << 32n,
  MuteMembers: 1n << 33n,
  DeafenMembers: 1n << 34n,
  MoveMembers: 1n << 35n,
  Listen: 1n << 36n,
  MentionEveryone: 1n << 37n,
  MentionRoles: 1n << 38n,
  BypassSlowmode: 1n << 39n,
  ViewAuditLogs: 1n << 40n,
  UseExternalEmojis: 1n << 41n,
  GrantAllSafe: 0x000f_ffff_ffff_ffffn,
} as const;

export type PermissionName = Exclude<keyof typeof Permission, "GrantAllSafe">;

export const ALLOW_IN_TIMEOUT = Permission.ViewChannel | Permission.ReadMessageHistory;
export const DEFAULT_PERMISSION_VIEW_ONLY = Permission.ViewChannel | Permission.ReadMessageHistory;
export const DEFAULT_PERMISSION =
  DEFAULT_PERMISSION_VIEW_ONLY |
  Permission.SendMessage |
  Permission.InviteOthers |
  Permission.SendEmbeds |
  Permission.UploadFiles |
  Permission.Connect |
  Permission.Speak |
  Permission.Video |
  Permission.Listen;
export const DEFAULT_PERMISSION_DIRECT_MESSAGE = DEFAULT_PERMISSION | Permission.React | Permission.ManageChannel;
export const DEFAULT_PERMISSION_SERVER =
  DEFAULT_PERMISSION |
  Permission.React |
  Permission.ChangeNickname |
  Permission.ChangeAvatar |
  Permission.UseExternalEmojis;

export interface OverrideField {
  a: number;
  d: number;
}

export function applyOverride(value: bigint, override: OverrideField | undefined): bigint {
  if (!override) return value;
  return (value | BigInt(override.a)) & ~BigInt(override.d);
}

export function has(value: bigint, permission: bigint): boolean {
  return (value & permission) === permission;
}

export function permissionName(permission: bigint): string {
  for (const [name, bit] of Object.entries(Permission)) if (bit === permission) return name;
  return "Unknown";
}

/** Largest valid permission value; anything above is rejected. */
export const PERMISSION_MASK = Permission.GrantAllSafe;

export function isPermissionValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    (BigInt(value) & ~PERMISSION_MASK) === 0n
  );
}
