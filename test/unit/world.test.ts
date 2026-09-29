import assert from "node:assert/strict";
import { test } from "node:test";

import { canonical } from "../../src/core/crypto.ts";
import { createEvent, dmScope, inviteCode, objectId, type Signer, type StoatEvent } from "../../src/core/event.ts";
import { EventStore } from "../../src/core/store.ts";
import { DEFAULT_PERMISSION_SERVER, Permission } from "../../src/state/permissions.ts";
import { World } from "../../src/state/world.ts";
import { causalShuffle, genesis, makeUser } from "../helpers.ts";

function setup() {
  const world = new World(new EventStore(null));
  const owner = makeUser();
  const { event, server } = genesis(owner);
  assert.equal(world.ingest(event).status, "accepted");
  const scope = `server:${server}`;
  const emit = (signer: Signer, type: string, body: Record<string, unknown>, extraDeps: string[] = []) => {
    const e = createEvent(signer, scope, type, body, [...world.heads(scope), ...extraDeps]);
    const result = world.ingest(e);
    assert.equal(result.status, "accepted", `${type}: ${result.reason}`);
    return e;
  };
  const state = () => world.server(server)!;
  const general = state().snap.server!.channels[0]!;
  const invite = () => inviteCode(emit(owner, "invite.create", { channel: general }));
  const send = (signer: Signer, content: string) => {
    const e = emit(signer, "message.send", { channel: general, content });
    return world.messages.get(general)!.get(objectId(e))!;
  };
  return { world, owner, server, scope, emit, state, general, invite, send };
}

test("genesis creates a server with a default channel", () => {
  const { state, owner, general } = setup();
  const snap = state().snap;
  assert.equal(snap.server!.owner, owner.user);
  assert.equal(snap.channels[general]!.name, "General");
  assert.equal(snap.server!.system_messages!.user_joined, general);
  assert.ok(snap.members[owner.user]);
  assert.equal(snap.server!.default_permissions, Number(DEFAULT_PERMISSION_SERVER));
});

test("joining through an invite, messaging and system messages", () => {
  const { world, emit, invite, send, state, general } = setup();
  const bob = makeUser();
  emit(bob, "member.join", { invite: invite() });
  assert.ok(state().snap.members[bob.user]);
  const joined = world.messages.get(general)!.query({ sort: "Oldest" });
  assert.equal(joined[0]!.system!.type, "user_joined");
  const message = send(bob, `hi <@${bob.user}>`);
  assert.ok(!message.hidden);
  assert.deepEqual(message.mentions, [bob.user]);
});

test("strangers cannot write into a server", () => {
  const { world, scope } = setup();
  const mallory = makeUser();
  const event = createEvent(mallory, scope, "channel.create", { name: "spam" }, world.heads(scope));
  assert.equal(world.ingest(event).status, "rejected");
  const badJoin = createEvent(mallory, scope, "member.join", { invite: "nope" }, world.heads(scope));
  assert.equal(world.ingest(badJoin).status, "accepted");
  const server = world.server(scope.slice(7))!;
  assert.ok(!server.snap.members[mallory.user], "join with an unknown invite has no effect");
});

test("permissions are enforced by every node", () => {
  const { emit, invite, send, state, owner } = setup();
  const bob = makeUser();
  emit(bob, "member.join", { invite: invite() });
  // Bob may not rename the server.
  emit(bob, "server.update", { name: "pwned" });
  assert.equal(state().snap.server!.name, "Test");
  // Owner revokes SendMessage for everyone.
  emit(owner, "server.permissions", {
    role: "default",
    permissions: Number(DEFAULT_PERMISSION_SERVER & ~Permission.SendMessage),
  });
  assert.ok(send(bob, "can you hear me?").hidden);
  assert.ok(!send(owner, "owner can").hidden);
});

test("role ranking protects higher roles", () => {
  const { emit, invite, state, owner } = setup();
  const [mod, admin, bob] = [makeUser(), makeUser(), makeUser()];
  const code = invite();
  for (const u of [mod, admin, bob]) emit(u, "member.join", { invite: code });
  const adminRole = objectId(emit(owner, "role.create", { name: "Admin" }));
  const modRole = objectId(emit(owner, "role.create", { name: "Mod" }));
  emit(owner, "server.permissions", {
    role: modRole,
    permissions: { allow: Number(Permission.KickMembers | Permission.AssignRoles), deny: 0 },
  });
  emit(owner, "member.edit", { user: admin.user, roles: [adminRole] });
  emit(owner, "member.edit", { user: mod.user, roles: [modRole] });
  const roles = state().snap.server!.roles;
  assert.ok(roles[adminRole]!.rank < roles[modRole]!.rank);

  emit(mod, "member.kick", { user: admin.user });
  assert.ok(state().snap.members[admin.user], "mod cannot kick admin");
  emit(mod, "member.edit", { user: bob.user, roles: [adminRole] });
  assert.deepEqual(state().snap.members[bob.user]!.roles, [], "mod cannot hand out a higher role");
  emit(mod, "member.kick", { user: bob.user });
  assert.ok(!state().snap.members[bob.user], "mod can kick a plain member");
});

test("bans hide later messages but keep history", () => {
  const { emit, invite, send, owner, world, general, scope } = setup();
  const bob = makeUser();
  emit(bob, "member.join", { invite: invite() });
  const before = send(bob, "before");
  const staleHeads = world.heads(scope);
  emit(owner, "ban.create", { user: bob.user, reason: "spam" });
  assert.ok(!world.server(scope.slice(7))!.snap.members[bob.user]);
  assert.ok(!before.hidden);
  // Bob's node still references the heads from before the ban.
  const late = createEvent(bob, scope, "message.send", { channel: general, content: "after" }, staleHeads, Date.now() + 5);
  world.ingest(late);
  assert.ok(world.messages.get(general)!.get(objectId(late))!.hidden);
});

test("events wait for their dependencies", () => {
  const source = setup();
  const bob = makeUser();
  source.emit(bob, "member.join", { invite: source.invite() });
  source.send(bob, "hello");
  const events = source.world.store.scopeEvents(source.scope);

  const replica = new World(new EventStore(null));
  const missing: string[][] = [];
  replica.on("missing", (ids) => missing.push(ids));
  const reversed = [...events].reverse();
  for (const event of reversed) replica.ingest(event);
  assert.ok(missing.length > 0);
  assert.equal(replica.pendingCount, 0);
  assert.equal(canonical(replica.server(source.server)!.snap), canonical(source.state().snap));
});

test("state is identical regardless of delivery order (including concurrent edits)", () => {
  const source = setup();
  const [a, b, c] = [makeUser(), makeUser(), makeUser()];
  const code = source.invite();
  for (const u of [a, b, c]) source.emit(u, "member.join", { invite: code });
  const role = objectId(source.emit(source.owner, "role.create", { name: "Admin" }));
  source.emit(source.owner, "server.permissions", {
    role,
    permissions: { allow: Number(Permission.ManageServer | Permission.KickMembers | Permission.ManageChannel), deny: 0 },
  });
  source.emit(source.owner, "member.edit", { user: a.user, roles: [role] });
  source.emit(source.owner, "member.edit", { user: b.user, roles: [role] });
  // Concurrent branch: both admins act on the same heads.
  const heads = source.world.heads(source.scope);
  const concurrent: StoatEvent[] = [
    createEvent(a, source.scope, "server.update", { name: "By A" }, heads),
    createEvent(b, source.scope, "server.update", { name: "By B" }, heads),
    createEvent(a, source.scope, "member.kick", { user: c.user }, heads),
    createEvent(source.owner, source.scope, "member.edit", { user: a.user, remove: ["Roles"] }, heads),
  ];
  for (const e of concurrent) source.world.ingest(e);
  source.emit(b, "channel.create", { name: "after-merge" });
  source.send(c, "maybe kicked");

  const events = source.world.store.scopeEvents(source.scope);
  const expected = canonical(source.state().snap);
  for (let seed = 1; seed <= 12; seed++) {
    const replica = new World(new EventStore(null));
    replica.batch(() => {
      for (const event of causalShuffle(events, seed)) replica.ingest(event);
    });
    assert.equal(canonical(replica.server(source.server)!.snap), expected, `seed ${seed}`);
    const visible = (w: World) =>
      w.messages
        .get(source.general)!
        .query({ limit: 100 })
        .map((m) => m.id);
    assert.deepEqual(visible(replica), visible(source.world));
  }
});

test("relationships fold deterministically", () => {
  const world = new World(new EventStore(null));
  const [a, b] = [makeUser(), makeUser()];
  const scope = dmScope(a.user, b.user);
  world.ingest(createEvent(a, scope, "relation.set", { status: "request" }));
  assert.equal(world.relationship(a.user, b.user), "Outgoing");
  assert.equal(world.relationship(b.user, a.user), "Incoming");
  world.ingest(createEvent(b, scope, "relation.set", { status: "accept" }, [], Date.now() + 1));
  assert.equal(world.relationship(a.user, b.user), "Friend");
  world.ingest(createEvent(b, scope, "relation.set", { status: "block" }, [], Date.now() + 2));
  assert.equal(world.relationship(b.user, a.user), "Blocked");
  assert.equal(world.relationship(a.user, b.user), "BlockedOther");
});
