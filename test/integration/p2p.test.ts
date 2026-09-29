// Several nodes replicating through the P2P layer, each with its own users
// connected through stoat.js.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { Message } from "stoat.js";

import { api, cleanup, connected, p2pUrl, register, startNode, waitFor } from "./harness.ts";

after(cleanup);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP4z8DwnwEIGGAMAEvVB/mHLfkbAAAAAElFTkSuQmCC",
  "base64",
);

async function upload(node: { port: number }, token: string, tag: string, name: string, data: Buffer, type: string) {
  const form = new FormData();
  form.append("file", new Blob([data], { type }), name);
  const res = await fetch(`http://127.0.0.1:${node.port}/autumn/${tag}`, {
    method: "POST",
    headers: { "X-Session-Token": token },
    body: form,
  });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
}

test("two nodes: join through an invite and chat both ways", async () => {
  const one = await startNode({ name: "one" });
  const two = await startNode({ name: "two", peers: [p2pUrl(one)] });
  await connected(one, two);

  const alice = await register(one, "alice");
  const bob = await register(two, "bob");

  const server = await alice.client.servers.createServer({ name: "Mesh" });
  const general = server.channels[0]!;
  await general.sendMessage({ content: "first message, before bob joined" });
  const invite = (await general.createInvite()) as unknown as { _id: string };

  // Bob's node has never seen this server: it resolves the invite through its peers.
  const preview = await api(two, "GET", `/invites/${invite._id}`, undefined, bob.token);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.server_name, "Mesh");
  const joined = await api(two, "POST", `/invites/${invite._id}`, undefined, bob.token);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.server._id, server.id);

  // Bob's client learns about the server live, with the history available.
  await waitFor(() => bob.client.servers.get(server.id), 5000, "ServerCreate on bob's client");
  const bobChannel = bob.client.channels.get(general.id)!;
  const history = await bobChannel.fetchMessages({ limit: 50 });
  assert.ok(history.some((m) => m.content === "first message, before bob joined"));

  // Alice sees Bob join (member list replicated from the other node).
  await waitFor(() => one.world.server(server.id)?.snap.members[bob.id], 5000, "bob's join on alice's node");

  const aliceGot = new Promise<Message>((resolve) =>
    alice.client.on("messageCreate", (m) => m.authorId === bob.id && resolve(m)),
  );
  await bobChannel.sendMessage({ content: `hi <@${alice.id}> from node two` });
  const received = await aliceGot;
  assert.equal(received.content, `hi <@${alice.id}> from node two`);
  assert.ok(received.mentionIds?.includes(alice.id));

  const bobGot = new Promise<Message>((resolve) => bob.client.on("messageCreate", (m) => m.authorId === alice.id && resolve(m)));
  const reply = await general.sendMessage({ content: "welcome!", replies: [{ id: received.id, mention: true }] });
  assert.equal((await bobGot).content, "welcome!");

  // Edits and reactions travel too.
  await reply.edit({ content: "welcome to the mesh!" });
  await waitFor(() => bob.client.messages.get(reply.id)?.content === "welcome to the mesh!", 5000, "edit on bob");
  await bob.client.messages.get(reply.id)!.react("🎉");
  await waitFor(() => alice.client.messages.get(reply.id)?.reactions.get("🎉")?.has(bob.id), 5000, "reaction on alice");

  // Profiles replicate: alice can fetch bob.
  const bobUser = await alice.client.users.fetch(bob.id);
  assert.equal(bobUser.username, "bob");
});

test("a relay hub connects nodes that cannot reach each other", async () => {
  const hub = await startNode({ name: "hub", relay: true });
  const left = await startNode({ name: "left", peers: [p2pUrl(hub)] });
  const right = await startNode({ name: "right", peers: [p2pUrl(hub)] });
  await connected(left, hub);
  await connected(right, hub);

  const lena = await register(left, "lena");
  const rick = await register(right, "rick");
  // Reconnect so the hub receives delegations for the new users.
  for (const node of [left, right]) {
    for (const peer of node.p2p.status().peers) void peer;
  }

  const server = await lena.client.servers.createServer({ name: "Behind NAT" });
  const channel = server.channels[0]!;
  const invite = (await channel.createInvite()) as unknown as { _id: string };

  const joined = await api(right, "POST", `/invites/${invite._id}`, undefined, rick.token);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));

  const lenaGot = new Promise<Message>((resolve) => lena.client.on("messageCreate", (m) => m.authorId === rick.id && resolve(m)));
  await waitFor(() => rick.client.channels.get(channel.id), 5000, "channel on rick");
  await rick.client.channels.get(channel.id)!.sendMessage({ content: "through the hub" });
  assert.equal((await lenaGot).content, "through the hub");
  assert.ok(!left.p2p.status().peers.some((p) => p.id === right.nodeId && p.connected), "left and right are not directly connected");
});

test("offline nodes catch up when they reconnect", async () => {
  const one = await startNode({ name: "a" });
  const alice = await register(one, "alice2");
  const server = await alice.client.servers.createServer({ name: "Catch up" });
  const channel = server.channels[0]!;
  const invite = (await channel.createInvite()) as unknown as { _id: string };

  const two = await startNode({ name: "b", peers: [p2pUrl(one)] });
  const bob = await register(two, "bob2");
  await connected(one, two);
  assert.equal((await api(two, "POST", `/invites/${invite._id}`, undefined, bob.token)).status, 200);
  await waitFor(() => one.world.server(server.id)?.snap.members[bob.id], 5000, "join replicated");

  // Take node two offline, keep chatting on node one.
  await two.stop();
  for (let i = 0; i < 5; i++) await channel.sendMessage({ content: `while you were away ${i}` });
  await server.edit({ name: "Catch up (renamed)" });

  // A fresh node process for bob (same in-memory state is gone, so replay from peers).
  const three = await startNode({ name: "b2", peers: [p2pUrl(one)] });
  const bob2 = await register(three, "bob3");
  await connected(one, three);
  const second = (await channel.createInvite()) as unknown as { _id: string };
  assert.equal((await api(three, "POST", `/invites/${second._id}`, undefined, bob2.token)).status, 200);
  await waitFor(() => three.world.server(server.id)?.snap.server?.name === "Catch up (renamed)", 5000, "rename");
  const messages = await api(three, "GET", `/channels/${channel.id}/messages?limit=50`, undefined, bob2.token);
  assert.equal(messages.body.filter((m: { content?: string }) => m.content?.startsWith("while you were away")).length, 5);
});

test("moderation is enforced on every node", async () => {
  const one = await startNode({ name: "mod-one" });
  const two = await startNode({ name: "mod-two", peers: [p2pUrl(one)] });
  await connected(one, two);
  const owner = await register(one, "owner");
  const troll = await register(two, "troll");
  const server = await owner.client.servers.createServer({ name: "Moderated" });
  const channel = server.channels[0]!;
  const invite = (await channel.createInvite()) as unknown as { _id: string };
  assert.equal((await api(two, "POST", `/invites/${invite._id}`, undefined, troll.token)).status, 200);
  await waitFor(() => one.world.server(server.id)?.snap.members[troll.id], 5000, "troll joined");

  // The troll cannot rename the server: its own node refuses...
  const rename = await api(two, "PATCH", `/servers/${server.id}`, { name: "pwned" }, troll.token);
  assert.equal(rename.status, 403);

  // ...and the owner's ban removes it everywhere.
  await server.banUser(troll.id, { reason: "trolling" });
  await waitFor(() => !two.world.server(server.id)?.snap.members[troll.id], 5000, "ban replicated");
  await waitFor(() => !troll.client.servers.get(server.id), 5000, "server removed from troll's client");
  const send = await api(two, "POST", `/channels/${channel.id}/messages`, { content: "still here?" }, troll.token);
  assert.equal(send.status, 404);
});

test("direct messages are end-to-end encrypted, files replicate", async () => {
  const hub = await startNode({ name: "dm-hub", relay: true });
  const one = await startNode({ name: "dm-one", peers: [p2pUrl(hub)] });
  const two = await startNode({ name: "dm-two", peers: [p2pUrl(hub)] });
  await connected(one, hub);
  await connected(two, hub);
  const ann = await register(one, "ann");
  const ben = await register(two, "ben");

  // Share a server so the nodes learn each other's profiles.
  const server = await ann.client.servers.createServer({ name: "Friends" });
  const invite = (await server.channels[0]!.createInvite()) as unknown as { _id: string };
  assert.equal((await api(two, "POST", `/invites/${invite._id}`, undefined, ben.token)).status, 200);
  await waitFor(() => one.world.profiles.get(ben.id)?.x25519 && two.world.profiles.get(ann.id)?.x25519, 5000, "profiles");

  const dm = await api(one, "GET", `/users/${ben.id}/dm`, undefined, ann.token);
  assert.equal(dm.body.channel_type, "DirectMessage");
  const fileId = await upload(one, ann.token, "attachments", "pixel.png", PNG, "image/png");
  const sent = await api(one, "POST", `/channels/${dm.body._id}/messages`, { content: "secret 🤫", attachments: [fileId] }, ann.token);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.attachments[0].metadata.type, "Image");

  const benGot = await waitFor(() => two.world.message(dm.body._id, sent.body._id), 5000, "dm on ben's node");
  assert.equal(benGot.content, "secret 🤫");
  await waitFor(() => ben.client.channels.get(dm.body._id), 5000, "dm channel on ben's client");

  // The hub relayed the event but cannot read it.
  const relayed = await waitFor(() => hub.store.get(benGot.event), 5000, "event on hub");
  assert.ok(relayed.body.enc, "DM body is encrypted");
  assert.ok(!JSON.stringify(relayed).includes("secret"), "no plaintext on the relay");
  assert.equal(hub.world.message(dm.body._id, sent.body._id), undefined);

  // Ben's node fetches the attachment from the network and verifies it.
  const file = await fetch(`http://127.0.0.1:${two.port}/autumn/attachments/${fileId}`);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  assert.equal(file.headers.get("content-type"), "image/png");
});
