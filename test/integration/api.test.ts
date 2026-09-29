// A single node driven through the official stoat.js SDK: checks that the
// node is a drop-in Stoat backend for clients.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { api, cleanup, register, startNode, waitFor } from "./harness.ts";

after(cleanup);

test("stoat.js can register, create a server and chat", async () => {
  const node = await startNode({ name: "solo" });
  const alice = await register(node, "alice");
  assert.equal(alice.client.user?.username, "alice");
  assert.match(alice.client.user!.discriminator, /^\d{4}$/);

  const server = await alice.client.servers.createServer({ name: "Stoat P2P" });
  assert.equal(server.name, "Stoat P2P");
  const channel = server.channels[0]!;
  assert.equal(channel.name, "General");

  const created = new Promise((resolve) => alice.client.once("messageCreate", resolve));
  const message = await channel.sendMessage({ content: "hello **world**" });
  await created;
  assert.equal(message.content, "hello **world**");

  await message.edit({ content: "hello again" });
  await waitFor(() => alice.client.messages.get(message.id)?.content === "hello again", 3000, "edit");

  await message.react("👍");
  await waitFor(() => alice.client.messages.get(message.id)?.reactions.get("👍")?.has(alice.id), 3000, "reaction");

  const history = await channel.fetchMessages({ limit: 10 });
  assert.ok(history.some((m) => m.id === message.id));
  // The server creation also produced a system message? Only for joins; here just ours.
  const second = await channel.sendMessage({ content: "second" });
  await second.delete();
  await waitFor(() => !alice.client.messages.has(second.id), 3000, "delete");

  const role = await server.createRole("Moderators");
  assert.ok(role.id);
  await server.edit({ description: "decentralized" });
  await waitFor(() => server.description === "decentralized", 3000, "server edit");

  const newChannel = await server.createChannel({ name: "random", type: "Text" });
  assert.equal(newChannel.name, "random");
  await waitFor(() => server.channels.length === 2, 3000, "channel in server");

  const invite = (await channel.createInvite()) as unknown as { _id: string };
  const lookup = await api(node, "GET", `/invites/${invite._id}`);
  assert.equal(lookup.body.server_name, "Stoat P2P");
});

test("errors follow the Stoat format", async () => {
  const node = await startNode({ name: "errors" });
  const bob = await register(node, "bob");
  const res = await api(node, "GET", "/servers/01J8ZZZZZZZZZZZZZZZZZZZZZZ", undefined, bob.token);
  assert.equal(res.status, 404);
  assert.equal(res.body.type, "UnknownServer");
  const unauth = await api(node, "GET", "/users/@me");
  assert.equal(unauth.status, 401);
  const badLogin = await api(node, "POST", "/auth/session/login", { email: "bob@example.test", password: "nope" });
  assert.equal(badLogin.body.type, "InvalidCredentials");
});

test("settings and unreads are kept locally", async () => {
  const node = await startNode({ name: "settings" });
  const carol = await register(node, "carol");
  await api(node, "POST", "/sync/settings/set?timestamp=5", { theme: '{"dark":true}' }, carol.token);
  const fetched = await api(node, "POST", "/sync/settings/fetch", { keys: ["theme"] }, carol.token);
  assert.deepEqual(fetched.body, { theme: [5, '{"dark":true}'] });
  const unreads = await api(node, "GET", "/sync/unreads", undefined, carol.token);
  assert.deepEqual(unreads.body, []);
});
