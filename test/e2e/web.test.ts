// End-to-end: two nodes, two browsers running the official Stoat web client.
// Alice (node A) creates a server and an invite in the UI; Bob (node B) joins
// with the code and they chat. Requires `npm run build:web` and Chromium.
//
//   CHROMIUM_PATH=/path/to/chrome npm run test:e2e

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { StoatNode } from "../../src/node.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const WEB = join(ROOT, "web", "dist");
const SHOTS = join(ROOT, "test-results");

function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const bases = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", join(homedir(), ".cache", "ms-playwright")];
  for (const base of bases) {
    if (!base || !existsSync(base)) continue;
    for (const dir of readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      const path = join(base, dir, "chrome-linux", "chrome");
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

const chromium = findChromium();
const skip = !existsSync(join(WEB, "index.html"))
  ? "web client not built (npm run build:web)"
  : !chromium
    ? "Chromium not found (set CHROMIUM_PATH)"
    : false;

const nodes: StoatNode[] = [];
after(async () => {
  await Promise.all(nodes.map((n) => n.stop()));
});

async function startNode(name: string, peers: string[] = []): Promise<StoatNode> {
  const node = new StoatNode({ dataDir: null, port: 0, host: "127.0.0.1", lan: false, webDir: WEB, name, peers });
  await node.start();
  nodes.push(node);
  return node;
}

test("two people on two nodes chat through the official Stoat web client", { skip, timeout: 120_000 }, async () => {
  const { chromium: pw } = await import("playwright-core");
  mkdirSync(SHOTS, { recursive: true });
  const a = await startNode("alpha");
  const b = await startNode("beta", [`ws://127.0.0.1:${a.port}/p2p`]);

  const browser = await pw.launch({ executablePath: chromium as string });
  try {
    const open = async (node: StoatNode) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      page.on("pageerror", (error) => console.log(`[${node.options.name}] page error: ${error.message}`));
      await page.goto(`http://localhost:${node.port}/`);
      return page;
    };
    type Page = Awaited<ReturnType<typeof open>>;

    const signUp = async (page: Page, username: string) => {
      await page.getByText("Create account").first().click();
      await page.locator('input[name="email"]').fill(`${username}@example.test`);
      await page.locator('input[type="password"]').fill("correct horse battery");
      await page.getByRole("button", { name: "Create account" }).click();
      await page.locator('input[name="username"]').fill(username);
      await page.getByRole("button", { name: "Confirm" }).click();
      await page.getByLabel("Create or join a server").waitFor();
    };

    const say = async (page: Page, text: string) => {
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    };

    // Alice: account, server, first message, invite — all in the UI.
    const alice = await open(a);
    if (process.env.E2E_DEBUG) {
      alice.on("websocket", (ws) => ws.on("framereceived", (f) => {
        const text = String(f.payload);
        if (/UserUpdate|ServerMemberJoin|"Message"/.test(text)) console.log("A <-", text.slice(0, 200));
      }));
      alice.on("response", async (r) => {
        if (r.url().includes("/api/users/")) console.log("A HTTP", r.status(), r.url(), (await r.text().catch(() => "")).slice(0, 150));
      });
    }
    await signUp(alice, "alice");
    await alice.getByLabel("Create or join a server").click();
    await alice.getByRole("button", { name: "Create" }).click();
    await alice.locator('input[name="name"]').fill("Decentralized Stoat");
    await alice.getByRole("button", { name: /Create/ }).last().click();
    await alice.getByText("This is the start of your conversation.").waitFor();
    await say(alice, "Hello from a node that belongs to me!");
    await alice.getByText("Hello from a node that belongs to me!").waitFor();

    await alice.getByText("General", { exact: true }).first().click({ button: "right" });
    await alice.getByText("Create Invite").click();
    const link = await alice.getByText(/\/invite\//).first().innerText();
    const code = /\/invite\/\s*([A-Za-z0-9\s]+)/.exec(link)![1]!.replace(/\s/g, "");
    await alice.screenshot({ path: join(SHOTS, "1-alice-invite.png") });
    await alice.getByRole("button", { name: "Ok" }).click();

    // Bob: his own node, which only knows node A as a peer.
    const bob = await open(b);
    await signUp(bob, "bob");
    await bob.getByLabel("Create or join a server").click();
    await bob.getByRole("button", { name: "Join" }).click();
    await bob.locator("input").last().fill(code);
    await bob.screenshot({ path: join(SHOTS, "2-bob-join.png") });
    await bob.getByRole("button", { name: "Join", exact: true }).last().click();
    try {
      // Node B has never seen this server: it resolves the code through its
      // peers, syncs the server, joins and opens it.
      await bob.getByText("Hello from a node that belongs to me!").waitFor({ timeout: 20_000 });
      await bob.getByText("joined the server").first().waitFor();
      await bob.getByText("Join a server").waitFor({ state: "detached", timeout: 10_000 });
    } catch (error) {
      await bob.screenshot({ path: join(SHOTS, "error-bob.png") });
      throw error;
    }

    await say(bob, "Hi Alice! Written on node B, delivered peer-to-peer.");
    await alice.getByText("Hi Alice! Written on node B, delivered peer-to-peer.").waitFor({ timeout: 15_000 });
    await say(alice, "Welcome, Bob 👋");
    try {
      await bob.getByText("Welcome, Bob").waitFor({ timeout: 15_000 });
    } catch (error) {
      await alice.screenshot({ path: join(SHOTS, "error-alice.png") });
      await bob.screenshot({ path: join(SHOTS, "error-bob.png") });
      throw error;
    }

    // Profiles replicate: node A shows Bob's real name, not a placeholder.
    await alice.locator("main, body").getByText("bob", { exact: true }).first().waitFor({ timeout: 10_000 });
    await alice.screenshot({ path: join(SHOTS, "3-alice-node-a.png") });
    await bob.screenshot({ path: join(SHOTS, "4-bob-node-b.png") });

    // The two nodes hold the same signed history.
    const server = [...a.world.servers.values()][0]!;
    assert.deepEqual(
      a.store.scopeEvents(server.scope).map((e) => e.id).sort(),
      b.store.scopeEvents(server.scope).map((e) => e.id).sort(),
    );
  } finally {
    await browser.close();
  }
});
