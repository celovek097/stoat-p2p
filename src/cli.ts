#!/usr/bin/env node
// Command line entry point: `stoat-p2p [options]`

import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Accounts } from "./api/accounts.ts";
import { userIdFromKey } from "./core/event.ts";
import { StoatNode } from "./node.ts";

const HELP = `stoat-p2p — decentralized Stoat chat node

Usage: stoat-p2p [options]
       stoat-p2p identity export --email <email> [--data <dir>] > identity.json
       stoat-p2p identity import --email <email> --password <pw> [--data <dir>] < identity.json

  --data <dir>         where events, accounts and files are stored (default ~/.stoat-p2p)
  --port <n>           HTTP port for the web client, API and peers (default 14702)
  --host <addr>        address to bind (default 0.0.0.0)
  --peer <url>         peer to connect to, e.g. ws://friend.example.org:14702/p2p (repeatable)
  --announce <url>     public p2p address of this node shared with peers (repeatable)
  --name <name>        node name shown to peers
  --relay              store and forward data for connected peers (always-on hub)
  --no-lan             disable discovery of nodes on the local network
  --no-registration    do not allow new local accounts
  --web <dir>          directory with the built Stoat web client (default ./web/dist)
  --trust-proxy        trust X-Forwarded-* headers (behind a reverse proxy)
  --verbose            debug logging
  -h, --help           show this help

Environment variables STOAT_P2P_DATA, STOAT_P2P_PORT, STOAT_P2P_PEERS (comma separated),
STOAT_P2P_ANNOUNCE, STOAT_P2P_NAME and STOAT_P2P_RELAY=1 work too.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    password: { type: "string" },
    data: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    peer: { type: "string", multiple: true },
    announce: { type: "string", multiple: true },
    name: { type: "string" },
    relay: { type: "boolean" },
    "no-lan": { type: "boolean" },
    "no-registration": { type: "boolean" },
    web: { type: "string" },
    "trust-proxy": { type: "boolean" },
    verbose: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const env = process.env;
const dataDir = resolve(values.data ?? env.STOAT_P2P_DATA ?? join(homedir(), ".stoat-p2p"));

// Identities are just keys: moving to another node means taking them along.
if (positionals[0] === "identity") {
  const accounts = new Accounts(dataDir);
  if (positionals[1] === "export") {
    const account = values.email ? accounts.byEmail(values.email) : undefined;
    if (!account) {
      console.error("unknown --email");
      process.exit(1);
    }
    process.stdout.write(
      `${JSON.stringify({ v: 1, user: account.id, created: account.created, keys: account.keys, x25519: account.x25519 }, null, 2)}\n`,
    );
    process.exit(0);
  }
  if (positionals[1] === "import") {
    const data = JSON.parse(readFileSync(0, "utf8"));
    if (!values.email || !values.password || values.password.length < 8) {
      console.error("--email and --password (8+ characters) are required");
      process.exit(1);
    }
    if (userIdFromKey(data.keys?.pub, data.created) !== data.user) {
      console.error("identity file is corrupt: key does not match user id");
      process.exit(1);
    }
    if (accounts.get(data.user) || accounts.byEmail(values.email)) {
      console.error("this identity or email already exists on this node");
      process.exit(1);
    }
    accounts.import(values.email, values.password, data.keys, data.x25519, data.created);
    accounts.flush();
    console.log(`imported ${data.user}; start the node and log in with ${values.email}`);
    process.exit(0);
  }
  process.stdout.write(HELP);
  process.exit(1);
}

const list = (value: string | undefined) => (value ? value.split(",").map((v) => v.trim()).filter(Boolean) : []);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = values.web ?? env.STOAT_P2P_WEB ?? join(root, "web", "dist");
const verbose = values.verbose || env.STOAT_P2P_VERBOSE === "1";

const node = new StoatNode({
  dataDir,
  port: Number(values.port ?? env.STOAT_P2P_PORT ?? 14702),
  host: values.host ?? env.STOAT_P2P_HOST ?? "0.0.0.0",
  peers: [...(values.peer ?? []), ...list(env.STOAT_P2P_PEERS)],
  announce: [...(values.announce ?? []), ...list(env.STOAT_P2P_ANNOUNCE)],
  name: values.name ?? env.STOAT_P2P_NAME ?? hostname(),
  relay: values.relay || env.STOAT_P2P_RELAY === "1",
  lan: !values["no-lan"] && env.STOAT_P2P_LAN !== "0",
  registration: !values["no-registration"] && env.STOAT_P2P_REGISTRATION !== "0",
  webDir: existsSync(join(webDir, "index.html")) ? webDir : null,
  trustProxy: values["trust-proxy"] || env.STOAT_P2P_TRUST_PROXY === "1",
  log: (level, message) => {
    if (level === "debug" && !verbose) return;
    const time = new Date().toISOString().slice(11, 19);
    (level === "warn" ? console.warn : console.log)(`${time} ${level.padEnd(5)} ${message}`);
  },
});

await node.start();
const url = `http://localhost:${node.port}`;
console.log(`
  stoat-p2p is running
  ─────────────────────────────────────────────
  Stoat web client   ${url}${node.options.webDir ? "" : "   (not built: run npm run build:web)"}
  Node dashboard     ${url}/node
  Peer address       ws://<this-host>:${node.port}/p2p
  Data directory     ${node.options.dataDir}
`);

const shutdown = async () => {
  console.log("stopping…");
  await node.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
