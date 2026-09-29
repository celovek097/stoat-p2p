// Users, profiles, direct messages and relationships.

import { discriminatorFor, dmChannelId, dmScope, savedChannelId } from "../../core/event.ts";
import { isUlid } from "../../core/ulid.ts";
import type { StoatNode } from "../../node.ts";
import { defaultAvatar } from "../files.ts";
import { ApiError, errors, type Router } from "../http.ts";
import { asObject, uploadedFile, USERNAME_RE } from "./common.ts";

export function registerUsers(router: Router, node: StoatNode): void {
  const s = node.serializer;

  const resolveUser = (id: string, me: string) => (id === "@me" ? me : id);

  router.get("/users/@me", (ctx) => s.user(ctx.account.id, ctx.account.id));

  router.get("/users/:id", async (ctx) => {
    const id = resolveUser(ctx.params.id!, ctx.account.id);
    if (!isUlid(id)) throw errors.unknownUser();
    if (!node.world.profiles.has(id)) {
      // The profile may still be on its way from another node: answer with a
      // placeholder for users we know about; a UserUpdate follows once it arrives.
      const known =
        node.world.dmsOf(id).length > 0 || [...node.world.servers.values()].some((state) => state.snap.members[id]);
      if (known) {
        void node.lookupUser(id);
        return s.user(id, ctx.account.id);
      }
      await node.lookupUser(id);
    }
    if (!node.world.profiles.has(id)) throw errors.unknownUser();
    return s.user(id, ctx.account.id);
  });

  router.patch("/users/:id", (ctx) => {
    const id = resolveUser(ctx.params.id!, ctx.account.id);
    if (id !== ctx.account.id) throw errors.notFound();
    const body = asObject(ctx.body);
    const changes: Record<string, unknown> = {};
    const remove: string[] = Array.isArray(body.remove) ? body.remove : [];
    if (body.display_name !== undefined) {
      if (typeof body.display_name !== "string" || body.display_name.length < 2 || body.display_name.length > 32) {
        throw errors.validation("display_name");
      }
      changes.display_name = body.display_name;
    }
    if (body.avatar !== undefined) changes.avatar = uploadedFile(node, body.avatar, "avatars");
    if (body.pronouns !== undefined) changes.pronouns = String(body.pronouns).slice(0, 64);
    const current = node.world.profiles.get(id);
    if (body.status !== undefined) changes.status = { ...current?.status, ...asObject(body.status) };
    if (body.profile !== undefined) {
      const profile = asObject(body.profile);
      const next = { ...current?.profile };
      if (profile.content !== undefined) next.content = String(profile.content).slice(0, 2000);
      if (profile.background !== undefined) next.background = uploadedFile(node, profile.background, "backgrounds");
      changes.profile = next;
    }
    for (const field of remove) {
      if (field === "Avatar") changes.avatar = undefined;
      else if (field === "DisplayName") changes.display_name = undefined;
      else if (field === "Pronouns") changes.pronouns = undefined;
      else if (field === "StatusText") changes.status = { ...((changes.status as object) ?? current?.status), text: undefined };
      else if (field === "StatusPresence") changes.status = { ...((changes.status as object) ?? current?.status), presence: undefined };
      else if (field === "ProfileContent") changes.profile = { ...((changes.profile as object) ?? current?.profile), content: undefined };
      else if (field === "ProfileBackground") changes.profile = { ...((changes.profile as object) ?? current?.profile), background: undefined };
    }
    node.publishProfile(ctx.account, changes);
    return s.user(id, id);
  });

  router.patch("/users/@me/username", (ctx) => {
    const { username, password } = asObject(ctx.body);
    if (!node.accounts.verifyPassword(ctx.account, password)) throw errors.invalidCredentials();
    if (typeof username !== "string" || username.length < 2 || username.length > 32 || !USERNAME_RE.test(username)) {
      throw new ApiError(400, "InvalidUsername");
    }
    node.publishProfile(ctx.account, { username });
    return s.user(ctx.account.id, ctx.account.id);
  });

  router.get(
    "/users/:id/default_avatar",
    (ctx) => {
      const id = ctx.params.id!;
      const svg = defaultAvatar(id, node.world.profiles.get(id)?.username ?? "?");
      ctx.res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
      ctx.res.end(svg);
    },
    false,
  );

  router.get("/users/:id/profile", (ctx) => s.profile(resolveUser(ctx.params.id!, ctx.account.id)));
  router.get("/users/:id/flags", () => ({ flags: 0 }), false);

  router.get("/users/:id/mutual", (ctx) => {
    const other = ctx.params.id!;
    const me = ctx.account.id;
    const servers = node.world
      .serversOf(me)
      .filter((state) => state.snap.members[other])
      .map((state) => state.id);
    const channels = node.world
      .dmsOf(me)
      .filter((dm) => dm.users.includes(other))
      .map((dm) => dm.channel);
    const friends = (user: string) =>
      new Set(
        node.world
          .dmsOf(user)
          .filter((dm) => dm.statuses[user] === "Friend")
          .map((dm) => (dm.users[0] === user ? dm.users[1] : dm.users[0])),
      );
    const theirs = friends(other);
    const users = [...friends(me)].filter((u) => theirs.has(u));
    return { users, servers, channels };
  });

  router.get("/users/dms", (ctx) => {
    const me = ctx.account.id;
    const out = node.dmChannelsOf(me).map((ref) => s.channel(ref)!);
    const saved = savedChannelId(me);
    if (node.world.lastMessageId(saved) || node.accounts.openDms(me).includes(saved)) out.push(s.savedMessages(me));
    return out;
  });

  router.get("/users/:id/dm", (ctx) => {
    const me = ctx.account.id;
    const other = resolveUser(ctx.params.id!, me);
    if (other === me) {
      const channel = savedChannelId(me);
      node.world.channels.set(channel, { kind: "saved", user: me, channel });
      if (node.accounts.openDm(me, channel)) {
        node.bonfire.sendTo(me, { type: "ChannelCreate", ...s.savedMessages(me) });
      }
      return s.savedMessages(me);
    }
    if (!isUlid(other)) throw errors.unknownUser();
    const dm = node.world.dmState(dmScope(me, other));
    node.p2p.subscribe(dm.scope);
    node.p2p.connectToUser(other);
    if (node.accounts.openDm(me, dm.channel)) {
      node.bonfire.sendTo(me, { type: "ChannelCreate", ...s.channel(node.world.channel(dm.channel)!)! });
    }
    return s.channel(node.world.channel(dmChannelId(me, other))!);
  });

  // Relationships -------------------------------------------------------------------

  const relation = async (me: string, other: string, status: string) => {
    if (!isUlid(other) || other === me) throw errors.unknownUser();
    const account = node.accounts.get(me)!;
    const scope = dmScope(me, other);
    node.world.dmState(scope);
    node.p2p.subscribe(scope);
    node.p2p.connectToUser(other);
    node.publish(account, scope, "relation.set", { status });
    return s.user(other, me);
  };

  router.post("/users/friend", async (ctx) => {
    const { username } = asObject(ctx.body);
    if (typeof username !== "string") throw errors.unknownUser();
    const [name, discriminator] = username.split("#");
    const matches = node.world.findUserByName(name!, discriminator, discriminatorFor);
    const target = matches.find((p) => p.user !== ctx.account.id);
    if (!target) throw errors.unknownUser();
    const status = node.world.relationship(ctx.account.id, target.user);
    if (status === "Friend") throw new ApiError(409, "AlreadyFriends");
    if (status === "Outgoing") throw new ApiError(409, "AlreadySentRequest");
    if (status === "Blocked") throw new ApiError(409, "Blocked");
    if (status === "BlockedOther") throw new ApiError(409, "BlockedByOther");
    return relation(ctx.account.id, target.user, status === "Incoming" ? "accept" : "request");
  });

  router.put("/users/:id/friend", (ctx) => {
    const status = node.world.relationship(ctx.account.id, ctx.params.id!);
    if (status === "Friend") throw new ApiError(409, "AlreadyFriends");
    return relation(ctx.account.id, ctx.params.id!, status === "Incoming" ? "accept" : "request");
  });

  router.delete("/users/:id/friend", (ctx) => relation(ctx.account.id, ctx.params.id!, "remove"));
  router.put("/users/:id/block", (ctx) => relation(ctx.account.id, ctx.params.id!, "block"));
  router.delete("/users/:id/block", (ctx) => relation(ctx.account.id, ctx.params.id!, "unblock"));
}
