import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  canonical,
  checkPassword,
  generateAgreementKey,
  hashPassword,
  open,
  seal,
  sharedSecret,
} from "../../src/core/crypto.ts";
import {
  createEvent,
  discriminatorFor,
  dmChannelId,
  dmScope,
  inviteCode,
  keyMatchesUser,
  objectId,
  parseScope,
  verifyEvent,
} from "../../src/core/event.ts";
import { EventStore } from "../../src/core/store.ts";
import { decodeTime, encodeTime, isUlid, ulidFrom } from "../../src/core/ulid.ts";
import { makeUser } from "../helpers.ts";

test("ULID encoding round-trips the timestamp", () => {
  const now = 1_727_600_000_123;
  assert.equal(decodeTime(encodeTime(now) + "0".repeat(16)), now);
  const id = ulidFrom(now, new Uint8Array(10).fill(255));
  assert.ok(isUlid(id));
  assert.equal(id.slice(10), "ZZZZZZZZZZZZZZZZ");
});

test("canonical JSON sorts keys and drops undefined", () => {
  assert.equal(canonical({ b: 1, a: [1, { d: undefined, c: "x" }] }), '{"a":[1,{"c":"x"}],"b":1}');
});

test("user ids are bound to public keys", () => {
  const alice = makeUser();
  const bob = makeUser();
  assert.ok(keyMatchesUser(alice.keys.pub, alice.user));
  assert.ok(!keyMatchesUser(bob.keys.pub, alice.user));
  assert.match(discriminatorFor(alice.keys.pub), /^\d{4}$/);
});

test("events are signed and tamper-evident", () => {
  const alice = makeUser();
  const event = createEvent(alice, `user:${alice.user}`, "user.profile", { username: "alice" });
  assert.equal(verifyEvent(event), null);
  assert.equal(verifyEvent({ ...event, body: { username: "mallory" } }), "id mismatch");
  const mallory = makeUser();
  const forged = createEvent(mallory, `user:${alice.user}`, "user.profile", { username: "alice" });
  assert.equal(verifyEvent({ ...forged, author: alice.user }), "id mismatch");
  assert.equal(verifyEvent({ ...event, sig: forged.sig }), "bad signature");
  const future = createEvent(alice, `user:${alice.user}`, "user.profile", { username: "a" }, [], Date.now() + 3_600_000);
  assert.equal(verifyEvent(future), "timestamp in the future");
});

test("derived identifiers are stable", () => {
  const alice = makeUser();
  const bob = makeUser();
  assert.equal(dmScope(alice.user, bob.user), dmScope(bob.user, alice.user));
  assert.equal(dmChannelId(alice.user, bob.user), dmChannelId(bob.user, alice.user));
  const parsed = parseScope(dmScope(alice.user, bob.user));
  assert.equal(parsed?.kind, "dm");
  const event = createEvent(alice, "server:01J8ZZZZZZZZZZZZZZZZZZZZZZ", "invite.create", { channel: "x" }, ["a".repeat(64)]);
  assert.equal(decodeTime(objectId(event)), event.ts);
  assert.match(inviteCode(event), /^[a-zA-Z0-9]{10}$/);
});

test("end-to-end sealing with X25519", () => {
  const a = generateAgreementKey();
  const b = generateAgreementKey();
  const k1 = sharedSecret(a, b.pub, "info");
  const k2 = sharedSecret(b, a.pub, "info");
  assert.deepEqual(k1, k2);
  const sealed = seal(k1, "hello", "aad");
  assert.equal(open(k2, sealed, "aad"), "hello");
  assert.equal(open(k2, sealed, "other"), null);
});

test("password hashing", () => {
  const stored = hashPassword("correct horse");
  assert.ok(checkPassword("correct horse", stored));
  assert.ok(!checkPassword("wrong", stored));
});

test("event store persists and summarises", () => {
  const dir = mkdtempSync(join(tmpdir(), "stoat-p2p-store-"));
  const alice = makeUser();
  const store = new EventStore(dir);
  const events = [1, 2, 3].map((n) =>
    createEvent(alice, `user:${alice.user}`, "user.profile", { username: `alice${n}` }, [], Date.now() - n * 86_400_000),
  );
  for (const event of events) store.add(event);
  const summary = store.summary(`user:${alice.user}`);
  assert.equal(Object.keys(summary).length, 3);
  const reloaded = new EventStore(dir).load();
  assert.deepEqual(
    reloaded.map((e) => e.id),
    events.map((e) => e.id),
  );
});
