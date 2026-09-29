// Invites. An invite code is derived from the `invite.create` event, so any
// node that has the server's events can resolve it; nodes that do not know
// it yet ask their peers.

import { serverScope } from "../../core/event.ts";
import type { StoatNode } from "../../node.ts";
import type { ServerState } from "../../state/server.ts";
import { ApiError, errors, type Router } from "../http.ts";

export function findInvite(node: StoatNode, code: string): { state: ServerState; channel: string; creator: string } | undefined {
  for (const state of node.world.servers.values()) {
    const invite = state.snap.invites[code];
    if (invite && state.snap.server && !state.snap.server.deleted) return { state, channel: invite.channel, creator: invite.creator };
  }
  return undefined;
}

export function registerInvites(router: Router, node: StoatNode): void {
  const s = node.serializer;

  const resolve = async (code: string) => {
    if (!/^[A-Za-z0-9]{1,32}$/.test(code)) throw errors.notFound();
    let found = findInvite(node, code);
    if (!found) {
      await node.lookupInvite(code);
      found = findInvite(node, code);
    }
    if (!found) throw errors.notFound();
    return found;
  };

  router.get("/invites/:code", async (ctx) => {
    const { state, channel, creator } = await resolve(ctx.params.code!);
    const server = state.snap.server!;
    const ch = state.snap.channels[channel]!;
    const profile = node.world.profiles.get(creator);
    const out: Record<string, unknown> = {
      type: "Server",
      code: ctx.params.code,
      server_id: server.id,
      server_name: server.name,
      channel_id: channel,
      channel_name: ch.name,
      user_name: profile?.display_name ?? profile?.username ?? "Unknown",
      member_count: Object.keys(state.snap.members).length,
    };
    if (server.icon) out.server_icon = server.icon;
    if (server.banner) out.server_banner = server.banner;
    if (server.flags) out.server_flags = server.flags;
    if (ch.description) out.channel_description = ch.description;
    if (profile?.avatar) out.user_avatar = profile.avatar;
    return out;
  }, false);

  router.post("/invites/:code", async (ctx) => {
    const code = ctx.params.code!;
    const { state } = await resolve(code);
    const me = ctx.account.id;
    if (state.snap.bans[me]) throw new ApiError(403, "Banned");
    if (state.snap.members[me]) throw new ApiError(409, "AlreadyInServer");
    node.publish(ctx.account, serverScope(state.id), "member.join", { invite: code }, [], undefined, "InvalidInvite");
    node.p2p.subscribe(serverScope(state.id));
    const joined = node.world.server(state.id)!;
    return {
      type: "Server",
      server: s.server(joined),
      channels: joined.snap.server!.channels.map((id) => s.serverChannel(joined.snap.channels[id]!)),
    };
  });

  router.delete("/invites/:code", (ctx) => {
    const found = findInvite(node, ctx.params.code!);
    if (!found || !found.state.snap.members[ctx.account.id]) throw errors.notFound();
    node.publish(ctx.account, found.state.scope, "invite.delete", { code: ctx.params.code }, [], undefined, "ManageServer");
    return undefined;
  });
}
