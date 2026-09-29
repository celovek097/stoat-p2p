// Servers, members, roles, bans, invites and emoji.

import { randomBytes } from "node:crypto";

import { objectId, serverIdFrom, serverScope } from "../../core/event.ts";
import type { StoatNode } from "../../node.ts";
import { isPermissionValue, Permission } from "../../state/permissions.ts";
import { memberRank, serverPermissions, type ServerState } from "../../state/server.ts";
import { ApiError, errors, type Router } from "../http.ts";
import { asObject, requireServer, requireServerPermission, uploadedFile } from "./common.ts";

export function registerServers(router: Router, node: StoatNode): void {
  const s = node.serializer;

  const withChannels = (state: ServerState) => ({
    server: s.server(state),
    channels: state.snap.server!.channels.map((id) => s.serverChannel(state.snap.channels[id]!)),
  });

  router.post("/servers/create", (ctx) => {
    const { name, description, nsfw } = asObject(ctx.body);
    if (typeof name !== "string" || !name.trim() || name.length > 32) throw errors.validation("name");
    if (description !== undefined && description !== null && (typeof description !== "string" || description.length > 1024)) {
      throw errors.validation("description");
    }
    const nonce = randomBytes(12).toString("hex");
    const ts = Date.now();
    const id = serverIdFrom(ts, ctx.account.keys.pub, nonce);
    node.publish(
      ctx.account,
      serverScope(id),
      "server.create",
      {
        nonce,
        name,
        description: description ?? undefined,
        nsfw: nsfw === true || undefined,
        channels: [{ name: "General", type: "Text" }],
        system_messages: true,
      },
      [],
      ts,
    );
    node.p2p.subscribe(serverScope(id));
    return withChannels(node.world.server(id)!);
  });

  router.get("/servers/:id", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    if (ctx.query.get("include_channels") === "true") {
      return { ...s.server(state), channels: state.snap.server!.channels.map((id) => s.serverChannel(state.snap.channels[id]!)) };
    }
    return s.server(state);
  });

  router.patch("/servers/:id", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    const body = asObject(ctx.body);
    const update: Record<string, unknown> = {};
    for (const key of ["name", "description", "categories", "system_messages", "nsfw", "owner"]) {
      if (body[key] !== undefined && body[key] !== null) update[key] = body[key];
    }
    if (body.icon) update.icon = uploadedFile(node, body.icon, "icons");
    if (body.banner) update.banner = uploadedFile(node, body.banner, "banners");
    if (Array.isArray(body.remove) && body.remove.length) update.remove = body.remove;
    if (body.categories !== undefined) requireServerPermission(state, ctx.account.id, "ManageChannel");
    if (Object.keys(update).some((k) => k !== "categories")) requireServerPermission(state, ctx.account.id, "ManageServer");
    if (!Object.keys(update).length) return s.server(state);
    node.publish(ctx.account, state.scope, "server.update", update);
    return s.server(node.world.server(state.id)!);
  });

  router.delete("/servers/:id", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    if (state.snap.server!.owner === ctx.account.id) node.publish(ctx.account, state.scope, "server.delete", {});
    else node.publish(ctx.account, state.scope, "member.leave", {});
    return undefined;
  });

  router.put("/servers/:id/ack", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    for (const channel of Object.keys(state.snap.channels)) {
      const last = node.world.lastMessageId(channel);
      if (last) node.accounts.ack(ctx.account.id, channel, last);
    }
    return undefined;
  });

  // Channels ------------------------------------------------------------------------
  router.post("/servers/:id/channels", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    requireServerPermission(state, ctx.account.id, "ManageChannel");
    const { type, name, description, nsfw } = asObject(ctx.body);
    if (typeof name !== "string" || !name.trim() || name.length > 32) throw errors.validation("name");
    const event = node.publish(ctx.account, state.scope, "channel.create", {
      type: type === "Voice" ? "Voice" : "Text",
      name,
      description: typeof description === "string" && description ? description : undefined,
      nsfw: nsfw === true || undefined,
    });
    return s.serverChannel(node.world.server(state.id)!.snap.channels[objectId(event)]!);
  });

  // Members -------------------------------------------------------------------------
  const memberList = (state: ServerState, me: string, filter?: (user: string) => boolean) => {
    const members = Object.values(state.snap.members).filter((m) => !filter || filter(m.user));
    return {
      members: members.map((m) => s.member(state.id, m)),
      users: members.map((m) => s.user(m.user, me)),
    };
  };

  router.get("/servers/:id/members", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    const excludeOffline = ctx.query.get("exclude_offline") === "true";
    return memberList(state, ctx.account.id, excludeOffline ? (u) => node.presence.isOnline(u) : undefined);
  });

  router.get("/servers/:id/members_experimental_query", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    const query = (ctx.query.get("query") ?? "").toLowerCase();
    return memberList(state, ctx.account.id, (user) => {
      const profile = node.world.profiles.get(user);
      const nickname = state.snap.members[user]?.nickname ?? "";
      return [profile?.username, profile?.display_name, nickname].some((n) => n?.toLowerCase().includes(query));
    });
  });

  router.get("/servers/:id/members/:user", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    const member = state.snap.members[ctx.params.user!];
    if (!member) throw errors.notFound();
    if (ctx.query.get("roles") === "true") {
      const roles = Object.fromEntries(member.roles.map((id) => [id, s.role(state.snap.server!.roles[id]!)]));
      return { member: s.member(state.id, member), roles };
    }
    return s.member(state.id, member);
  });

  router.patch("/servers/:id/members/:user", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    const target = ctx.params.user === "@me" ? ctx.account.id : ctx.params.user!;
    if (!state.snap.members[target]) throw errors.notFound();
    const body = asObject(ctx.body);
    const edit: Record<string, unknown> = { user: target };
    if (typeof body.nickname === "string") edit.nickname = body.nickname;
    if (typeof body.pronouns === "string") edit.pronouns = body.pronouns;
    if (body.avatar) edit.avatar = uploadedFile(node, body.avatar, "avatars");
    if (Array.isArray(body.roles)) edit.roles = body.roles;
    if (body.timeout) {
      const timeout = Date.parse(body.timeout);
      if (Number.isNaN(timeout)) throw errors.validation("timeout");
      edit.timeout = timeout;
    }
    if (Array.isArray(body.remove) && body.remove.length) edit.remove = body.remove;
    node.publish(ctx.account, state.scope, "member.edit", edit, [], undefined, "ManageNicknames");
    return s.member(state.id, node.world.server(state.id)!.snap.members[target]!);
  });

  router.delete("/servers/:id/members/:user", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    const target = ctx.params.user!;
    if (target === ctx.account.id) throw new ApiError(400, "CannotRemoveYourself");
    if (!state.snap.members[target]) throw errors.notFound();
    requireServerPermission(state, ctx.account.id, "KickMembers");
    if (memberRank(state.snap, target) <= memberRank(state.snap, ctx.account.id)) throw new ApiError(403, "NotElevated");
    node.publish(ctx.account, state.scope, "member.kick", { user: target });
    return undefined;
  });

  // Bans ---------------------------------------------------------------------------
  router.put("/servers/:id/bans/:user", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    const target = ctx.params.user!;
    if (target === ctx.account.id) throw new ApiError(400, "CannotRemoveYourself");
    requireServerPermission(state, ctx.account.id, "BanMembers");
    if (state.snap.members[target] && memberRank(state.snap, target) <= memberRank(state.snap, ctx.account.id)) {
      throw new ApiError(403, "NotElevated");
    }
    const { reason } = (ctx.body ?? {}) as { reason?: string };
    node.publish(ctx.account, state.scope, "ban.create", { user: target, reason: typeof reason === "string" ? reason : undefined });
    return { _id: { server: state.id, user: target }, reason };
  });

  router.delete("/servers/:id/bans/:user", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    requireServerPermission(state, ctx.account.id, "BanMembers");
    if (!state.snap.bans[ctx.params.user!]) throw errors.notFound();
    node.publish(ctx.account, state.scope, "ban.remove", { user: ctx.params.user });
    return undefined;
  });

  router.get("/servers/:id/bans", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    requireServerPermission(state, ctx.account.id, "BanMembers");
    const bans = Object.entries(state.snap.bans);
    return {
      users: bans.map(([user]) => {
        const u = s.user(user, ctx.account.id);
        return { _id: user, username: u.username, discriminator: u.discriminator, avatar: u.avatar };
      }),
      bans: bans.map(([user, ban]) => ({ _id: { server: state.id, user }, reason: ban.reason })),
    };
  });

  router.get("/servers/:id/invites", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    requireServerPermission(state, ctx.account.id, "ManageServer");
    return Object.values(state.snap.invites).map((invite) => s.invite(state.id, invite));
  });

  // Roles and permissions ---------------------------------------------------------------
  router.post("/servers/:id/roles", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    requireServerPermission(state, ctx.account.id, "ManageRole");
    const { name, rank } = asObject(ctx.body);
    if (typeof name !== "string" || !name.trim() || name.length > 32) throw errors.validation("name");
    const event = node.publish(ctx.account, state.scope, "role.create", { name, rank: Number.isSafeInteger(rank) ? rank : undefined });
    const id = objectId(event);
    const role = node.world.server(state.id)!.snap.server!.roles[id]!;
    return { id, role: { _id: id, ...s.role(role) } };
  });

  router.get("/servers/:id/roles/:role", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    const role = state.snap.server!.roles[ctx.params.role!];
    if (!role) throw errors.notFound();
    return { _id: ctx.params.role, ...s.role(role) };
  });

  router.patch("/servers/:id/roles/ranks", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    requireServerPermission(state, ctx.account.id, "ManageRole");
    const { ranks } = asObject(ctx.body);
    node.publish(ctx.account, state.scope, "role.ranks", { ranks }, [], undefined, "ManageRole");
    const updated = node.world.server(state.id)!;
    node.bonfire.broadcast({ type: "ServerRoleRanksUpdate", id: state.id, ranks }, () => true);
    return s.server(updated);
  });

  router.patch("/servers/:id/roles/:role", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    requireServerPermission(state, ctx.account.id, "ManageRole");
    const roleId = ctx.params.role!;
    if (!state.snap.server!.roles[roleId]) throw errors.notFound();
    const body = asObject(ctx.body);
    const update: Record<string, unknown> = { role: roleId };
    for (const key of ["name", "colour", "hoist", "rank"]) if (body[key] !== undefined && body[key] !== null) update[key] = body[key];
    if (body.icon) update.icon = uploadedFile(node, body.icon, "icons");
    if (Array.isArray(body.remove) && body.remove.length) update.remove = body.remove;
    node.publish(ctx.account, state.scope, "role.update", update, [], undefined, "ManageRole");
    return { _id: roleId, ...s.role(node.world.server(state.id)!.snap.server!.roles[roleId]!) };
  });

  router.delete("/servers/:id/roles/:role", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    requireServerPermission(state, ctx.account.id, "ManageRole");
    if (!state.snap.server!.roles[ctx.params.role!]) throw errors.notFound();
    node.publish(ctx.account, state.scope, "role.delete", { role: ctx.params.role }, [], undefined, "ManageRole");
    return undefined;
  });

  router.put("/servers/:id/permissions/:role", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    requireServerPermission(state, ctx.account.id, "ManagePermissions");
    const { permissions } = asObject(ctx.body);
    const role = ctx.params.role!;
    if (role === "default") {
      if (!isPermissionValue(permissions)) throw errors.validation("permissions");
    } else {
      if (!state.snap.server!.roles[role]) throw errors.notFound();
      if (typeof permissions !== "object" || permissions === null) throw errors.validation("permissions");
    }
    const own = serverPermissions(state.snap, ctx.account.id);
    void own;
    node.publish(ctx.account, state.scope, "server.permissions", { role, permissions }, [], undefined, "CannotGiveMissingPermissions");
    return s.server(node.world.server(state.id)!);
  });

  // Emoji ---------------------------------------------------------------------------
  router.get("/servers/:id/emojis", (ctx) => {
    const state = requireServer(node, ctx.params.id!, ctx.account);
    return Object.values(state.snap.emojis).map((emoji) => s.emoji(state.id, emoji));
  });

  router.put("/custom/emoji/:id", (ctx) => {
    const { name, parent, nsfw } = asObject(ctx.body);
    if (parent?.type !== "Server" || typeof parent.id !== "string") throw errors.validation("parent");
    const state = requireServer(node, parent.id, ctx.account);
    requireServerPermission(state, ctx.account.id, "ManageCustomisation");
    const file = uploadedFile(node, ctx.params.id, "emojis");
    const event = node.publish(ctx.account, state.scope, "emoji.create", { name, file, nsfw: nsfw === true || undefined });
    const emoji = node.world.server(state.id)!.snap.emojis[objectId(event)];
    if (!emoji) throw errors.validation("name");
    return s.emoji(state.id, emoji);
  });

  router.get("/custom/emoji/:id", (ctx) => {
    for (const state of node.world.servers.values()) {
      const emoji = state.snap.emojis[ctx.params.id!];
      if (emoji) return s.emoji(state.id, emoji);
    }
    throw errors.notFound();
  });

  router.delete("/custom/emoji/:id", (ctx) => {
    for (const state of node.world.serversOf(ctx.account.id)) {
      if (state.snap.emojis[ctx.params.id!]) {
        node.publish(ctx.account, state.scope, "emoji.delete", { emoji: ctx.params.id }, [], undefined, "ManageCustomisation");
        return undefined;
      }
    }
    throw errors.notFound();
  });

  router.get("/servers/:id/audit_logs", (ctx) => {
    requireServer(node, ctx.params.id!, ctx.account);
    return { audit_logs: [], users: [], members: [] };
  });

  void Permission;
}
