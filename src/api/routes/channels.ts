// Channels and messages.

import { dmScope, savedScope, serverScope } from "../../core/event.ts";
import { isUlid } from "../../core/ulid.ts";
import type { StoatNode } from "../../node.ts";
import { has, Permission } from "../../state/permissions.ts";
import type { MessageData } from "../../state/types.ts";
import type { ChannelRef } from "../../state/world.ts";
import type { Account } from "../accounts.ts";
import { ApiError, errors, type RequestContext, type Router } from "../http.ts";
import type { Json } from "../serialize.ts";
import { asObject, permissionsIn, requireChannel, requirePermission, uploadedFile } from "./common.ts";

export function scopeOf(ref: ChannelRef): string {
  switch (ref.kind) {
    case "server":
      return serverScope(ref.server);
    case "dm":
      return dmScope(ref.users[0], ref.users[1]);
    case "saved":
      return savedScope(ref.user);
  }
}

export function registerChannels(router: Router, node: StoatNode): void {
  const s = node.serializer;

  const withUsers = (ctx: RequestContext, ref: ChannelRef, messages: MessageData[]) => {
    const out = messages.map((m) => s.message(m));
    if (ctx.query.get("include_users") !== "true" && ctx.body?.include_users !== true) return out;
    const authors = [...new Set(messages.map((m) => m.author))];
    const result: Json = { messages: out, users: authors.map((id) => s.user(id, ctx.account.id)) };
    if (ref.kind === "server") {
      const state = node.world.server(ref.server)!;
      result.members = authors.filter((id) => state.snap.members[id]).map((id) => s.member(ref.server, state.snap.members[id]!));
    }
    return result;
  };

  const requireMessage = (ref: ChannelRef, id: string | undefined) => {
    const message = isUlid(id) ? node.world.message(ref.channel, id) : undefined;
    if (!message) throw errors.unknownMessage();
    return message;
  };

  /** Publish a content event that references an existing message. */
  const onMessage = (account: Account, ref: ChannelRef, message: MessageData, type: string, body: Json) =>
    node.publish(account, scopeOf(ref), type, { message: message.id, ...body }, [message.event]);

  router.get("/channels/:id", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    return s.channel(ref);
  });

  router.patch("/channels/:id", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    if (ref.kind !== "server") throw errors.invalidOperation();
    requirePermission(permissionsIn(node, ref, ctx.account.id), "ManageChannel");
    const body = asObject(ctx.body);
    const update: Json = { channel: ref.channel };
    for (const key of ["name", "description", "nsfw", "slowmode"]) if (body[key] !== undefined && body[key] !== null) update[key] = body[key];
    if (body.icon) update.icon = uploadedFile(node, body.icon, "icons");
    if (Array.isArray(body.remove) && body.remove.length) update.remove = body.remove;
    node.publish(ctx.account, scopeOf(ref), "channel.update", update, [], undefined, "ManageChannel");
    return s.channel(ref);
  });

  router.delete("/channels/:id", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    if (ref.kind === "server") {
      requirePermission(permissionsIn(node, ref, ctx.account.id), "ManageChannel");
      node.publish(ctx.account, scopeOf(ref), "channel.delete", { channel: ref.channel }, [], undefined, "ManageChannel");
    }
    return undefined;
  });

  router.put("/channels/:id/ack/:message", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    const message = ctx.params.message!;
    if (!isUlid(message)) throw errors.unknownMessage();
    node.accounts.ack(ctx.account.id, ref.channel, message);
    node.bonfire.sendTo(ctx.account.id, { type: "ChannelAck", id: ref.channel, user: ctx.account.id, message_id: message }, ctx.session.id);
    return undefined;
  });

  router.get("/channels/:id/members", (ctx) => {
    requireChannel(node, ctx.params.id!, ctx.account);
    return [];
  });

  router.post("/channels/:id/invites", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    if (ref.kind !== "server") throw errors.invalidOperation();
    requirePermission(permissionsIn(node, ref, ctx.account.id), "InviteOthers");
    const event = node.publish(ctx.account, scopeOf(ref), "invite.create", { channel: ref.channel }, [], undefined, "InviteOthers");
    const state = node.world.server(ref.server)!;
    const invite = Object.values(state.snap.invites).find((i) => i.created === event.ts && i.creator === ctx.account.id);
    return s.invite(ref.server, invite!);
  });

  router.post("/channels/:id/webhooks", () => {
    throw errors.featureDisabled("webhooks");
  });
  router.get("/channels/:id/webhooks", () => []);
  router.post("/channels/:id/join_call", () => {
    throw new ApiError(400, "LiveKitUnavailable");
  });
  router.post("/channels/create", () => {
    throw errors.featureDisabled("groups");
  });

  // Permission overrides ------------------------------------------------------------------
  router.put("/channels/:id/permissions/:role", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    if (ref.kind !== "server") throw errors.invalidOperation();
    requirePermission(permissionsIn(node, ref, ctx.account.id), "ManagePermissions");
    const { permissions } = asObject(ctx.body);
    if (typeof permissions !== "object" || permissions === null) throw errors.validation("permissions");
    node.publish(
      ctx.account,
      scopeOf(ref),
      "channel.permissions",
      { channel: ref.channel, role: ctx.params.role, permissions },
      [],
      undefined,
      "CannotGiveMissingPermissions",
    );
    return s.channel(ref);
  });

  // Messages -------------------------------------------------------------------------
  router.get("/channels/:id/messages", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    requirePermission(permissionsIn(node, ref, ctx.account.id), "ReadMessageHistory");
    const q = ctx.query;
    const messages =
      node.world.messages.get(ref.channel)?.query({
        limit: q.get("limit") ? Number(q.get("limit")) : undefined,
        before: q.get("before") ?? undefined,
        after: q.get("after") ?? undefined,
        sort: (q.get("sort") as "Latest" | "Oldest" | null) ?? undefined,
        nearby: q.get("nearby") ?? undefined,
      }) ?? [];
    return withUsers(ctx, ref, messages);
  });

  router.post("/channels/:id/search", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    requirePermission(permissionsIn(node, ref, ctx.account.id), "ReadMessageHistory");
    const body = asObject(ctx.body);
    const messages =
      node.world.messages.get(ref.channel)?.query({
        limit: body.limit,
        before: body.before,
        after: body.after,
        sort: body.sort === "Oldest" ? "Oldest" : "Latest",
        search: typeof body.query === "string" ? body.query : undefined,
        pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
      }) ?? [];
    return withUsers(ctx, ref, messages);
  });

  const recentNonces = new Map<string, { at: number; message: string; channel: string }>();

  router.post("/channels/:id/messages", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    const perms = permissionsIn(node, ref, ctx.account.id);
    requirePermission(perms, "SendMessage");
    const body = asObject(ctx.body);
    const idempotency = (ctx.req.headers["idempotency-key"] as string | undefined) ?? body.nonce;
    if (typeof idempotency === "string") {
      const seen = recentNonces.get(`${ctx.account.id}:${idempotency}`);
      if (seen && seen.channel === ref.channel) {
        const existing = node.world.message(seen.channel, seen.message);
        if (existing) return s.message(existing);
      }
    }
    const content = typeof body.content === "string" ? body.content : undefined;
    if (content && content.length > 2000) throw errors.validation("content");
    const attachments = Array.isArray(body.attachments) ? body.attachments.map((id: unknown) => uploadedFile(node, id, "attachments")) : [];
    if (attachments.length > 5) throw new ApiError(400, "TooManyAttachments", { max: 5 });
    if (attachments.length) requirePermission(perms, "UploadFiles");
    if (Array.isArray(body.embeds) && body.embeds.length) requirePermission(perms, "SendEmbeds");
    if (body.masquerade) requirePermission(perms, "Masquerade");
    if (!content?.trim() && !attachments.length && !(Array.isArray(body.embeds) && body.embeds.length)) {
      throw new ApiError(400, "EmptyMessage");
    }
    const replies = Array.isArray(body.replies) ? body.replies.slice(0, 5) : undefined;
    const deps: string[] = [];
    for (const reply of replies ?? []) {
      const event = isUlid(reply?.id) ? node.world.messageEvent(ref.channel, reply.id) : undefined;
      if (event) deps.push(event);
      else if (reply?.fail_if_not_exists !== false) throw errors.unknownMessage();
    }
    const event = node.publish(
      ctx.account,
      scopeOf(ref),
      "message.send",
      {
        channel: ref.channel,
        content: content || undefined,
        attachments: attachments.length ? attachments : undefined,
        replies: replies?.filter((r: { id?: string }) => node.world.messageEvent(ref.channel, r.id!)).map((r: { id: string; mention?: boolean }) => ({
          id: r.id,
          mention: r.mention === true,
        })),
        embeds: Array.isArray(body.embeds) && body.embeds.length ? body.embeds : undefined,
        masquerade: body.masquerade ?? undefined,
        interactions: body.interactions ?? undefined,
        nonce: typeof body.nonce === "string" ? body.nonce : typeof idempotency === "string" ? idempotency : undefined,
        flags: Number.isSafeInteger(body.flags) ? body.flags : undefined,
      },
      deps,
    );
    const message = node.messageForEvent(ref.channel, event);
    if (!message) throw errors.invalidOperation();
    if (typeof idempotency === "string") {
      recentNonces.set(`${ctx.account.id}:${idempotency}`, { at: Date.now(), message: message.id, channel: ref.channel });
      if (recentNonces.size > 5000) {
        for (const [key, value] of recentNonces) if (Date.now() - value.at > 600_000) recentNonces.delete(key);
      }
    }
    node.accounts.ack(ctx.account.id, ref.channel, message.id);
    return s.message(message);
  });

  router.get("/channels/:id/messages/:message", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    requirePermission(permissionsIn(node, ref, ctx.account.id), "ReadMessageHistory");
    return s.message(requireMessage(ref, ctx.params.message));
  });

  router.patch("/channels/:id/messages/:message", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    const message = requireMessage(ref, ctx.params.message);
    if (message.author !== ctx.account.id) throw new ApiError(403, "CannotEditMessage");
    const body = asObject(ctx.body);
    if (body.content !== undefined && (typeof body.content !== "string" || body.content.length > 2000)) {
      throw errors.validation("content");
    }
    onMessage(ctx.account, ref, message, "message.edit", { content: body.content, embeds: body.embeds });
    return s.message(node.world.message(ref.channel, message.id)!);
  });

  router.delete("/channels/:id/messages/bulk", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    requirePermission(permissionsIn(node, ref, ctx.account.id), "ManageMessages");
    const { ids } = asObject(ctx.body);
    for (const id of Array.isArray(ids) ? ids.slice(0, 100) : []) {
      const message = isUlid(id) ? node.world.message(ref.channel, id) : undefined;
      if (message && !message.system) onMessage(ctx.account, ref, message, "message.delete", {});
    }
    return undefined;
  });

  router.delete("/channels/:id/messages/:message", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    const message = requireMessage(ref, ctx.params.message);
    if (message.author !== ctx.account.id && !has(permissionsIn(node, ref, ctx.account.id), Permission.ManageMessages)) {
      throw new ApiError(403, "CannotDeleteMessage");
    }
    if (message.system) throw new ApiError(403, "CannotDeleteMessage");
    onMessage(ctx.account, ref, message, "message.delete", {});
    return undefined;
  });

  router.post("/channels/:id/messages/:message/pin", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    requirePermission(permissionsIn(node, ref, ctx.account.id), "ManageMessages");
    const message = requireMessage(ref, ctx.params.message);
    if (message.pinned) throw new ApiError(400, "AlreadyPinned");
    onMessage(ctx.account, ref, message, "message.pin", {});
    return undefined;
  });

  router.delete("/channels/:id/messages/:message/pin", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    requirePermission(permissionsIn(node, ref, ctx.account.id), "ManageMessages");
    const message = requireMessage(ref, ctx.params.message);
    if (!message.pinned) throw new ApiError(400, "NotPinned");
    onMessage(ctx.account, ref, message, "message.unpin", {});
    return undefined;
  });

  router.put("/channels/:id/messages/:message/reactions/:emoji", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    requirePermission(permissionsIn(node, ref, ctx.account.id), "React");
    const message = requireMessage(ref, ctx.params.message);
    onMessage(ctx.account, ref, message, "message.react", { emoji: ctx.params.emoji });
    return undefined;
  });

  router.delete("/channels/:id/messages/:message/reactions/:emoji", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    const message = requireMessage(ref, ctx.params.message);
    const emoji = ctx.params.emoji!;
    const user = ctx.query.get("user_id");
    if (ctx.query.get("remove_all") === "true") {
      requirePermission(permissionsIn(node, ref, ctx.account.id), "ManageMessages");
      onMessage(ctx.account, ref, message, "message.clear_reactions", { emoji });
    } else {
      if (user && user !== ctx.account.id) requirePermission(permissionsIn(node, ref, ctx.account.id), "ManageMessages");
      onMessage(ctx.account, ref, message, "message.unreact", { emoji, user: user && user !== ctx.account.id ? user : undefined });
    }
    return undefined;
  });

  router.delete("/channels/:id/messages/:message/reactions", (ctx) => {
    const ref = requireChannel(node, ctx.params.id!, ctx.account);
    requirePermission(permissionsIn(node, ref, ctx.account.id), "ManageMessages");
    const message = requireMessage(ref, ctx.params.message);
    onMessage(ctx.account, ref, message, "message.clear_reactions", {});
    return undefined;
  });
}
