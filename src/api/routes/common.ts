import { isUlid } from "../../core/ulid.ts";
import type { StoatNode } from "../../node.ts";
import {
  DEFAULT_PERMISSION_DIRECT_MESSAGE,
  DEFAULT_PERMISSION_VIEW_ONLY,
  has,
  Permission,
  type PermissionName,
} from "../../state/permissions.ts";
import { channelPermissions, serverPermissions, type ServerState } from "../../state/server.ts";
import type { FileObject } from "../../state/types.ts";
import type { ChannelRef } from "../../state/world.ts";
import type { Account } from "../accounts.ts";
import { ApiError, errors } from "../http.ts";

export function requireServer(node: StoatNode, id: string, account: Account): ServerState {
  const state = node.world.server(id);
  if (!state || !state.snap.members[account.id]) throw errors.unknownServer();
  return state;
}

export function requireChannel(node: StoatNode, id: string, account: Account): ChannelRef {
  const ref = node.world.channel(id);
  if (!ref) throw errors.unknownChannel();
  if (ref.kind === "server" && !node.world.server(ref.server)?.snap.members[account.id]) throw errors.unknownChannel();
  if (ref.kind === "dm" && !ref.users.includes(account.id)) throw errors.unknownChannel();
  if (ref.kind === "saved" && ref.user !== account.id) throw errors.unknownChannel();
  if (!has(permissionsIn(node, ref, account.id), Permission.ViewChannel)) throw errors.unknownChannel();
  return ref;
}

export function permissionsIn(node: StoatNode, ref: ChannelRef, user: string): bigint {
  switch (ref.kind) {
    case "server": {
      const state = node.world.server(ref.server);
      return state ? channelPermissions(state.snap, ref.channel, user) : 0n;
    }
    case "dm": {
      const other = ref.users[0] === user ? ref.users[1] : ref.users[0];
      const status = node.world.relationship(user, other);
      return status === "Blocked" || status === "BlockedOther" ? DEFAULT_PERMISSION_VIEW_ONLY : DEFAULT_PERMISSION_DIRECT_MESSAGE;
    }
    case "saved":
      return Permission.GrantAllSafe;
  }
}

export function requirePermission(value: bigint, permission: PermissionName): void {
  if (!has(value, Permission[permission])) throw errors.missingPermission(permission);
}

export function requireServerPermission(state: ServerState, user: string, permission: PermissionName): void {
  requirePermission(serverPermissions(state.snap, user), permission);
}

/** Resolve an Autumn upload id (uploaded through this node) to a File object. */
export function uploadedFile(node: StoatNode, id: unknown, tag: string): FileObject {
  const file = typeof id === "string" ? node.files.meta(id) : undefined;
  if (!file || file.tag !== tag) throw new ApiError(400, "UnknownAttachment");
  return file;
}

export function ulidParam(value: string | undefined, error: () => ApiError = errors.notFound): string {
  if (!isUlid(value)) throw error();
  return value;
}

export function asObject(body: unknown): Record<string, any> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw errors.validation("expected a JSON object");
  return body as Record<string, any>;
}

export const USERNAME_RE = /^(\p{L}|[\d_.-])+$/u;
