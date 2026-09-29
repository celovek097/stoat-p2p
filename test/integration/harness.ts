// Spin up in-process nodes and drive them with the official stoat.js SDK.

import { Client } from "stoat.js";

import { StoatNode, type NodeOptions } from "../../src/node.ts";
import { waitFor } from "../helpers.ts";

export { waitFor };

const nodes: StoatNode[] = [];
const clients: Client[] = [];

export async function startNode(options: Partial<NodeOptions> = {}): Promise<StoatNode> {
  const node = new StoatNode({
    dataDir: null,
    port: 0,
    host: "127.0.0.1",
    lan: false,
    log: (level, message) => {
      if (process.env.DEBUG_NODES) console.log(`[${options.name ?? "node"}] ${level} ${message}`);
    },
    ...options,
  });
  await node.start();
  nodes.push(node);
  return node;
}

export function p2pUrl(node: StoatNode): string {
  return `ws://127.0.0.1:${node.port}/p2p`;
}

export function apiUrl(node: StoatNode): string {
  return `http://127.0.0.1:${node.port}/api`;
}

export async function api(node: StoatNode, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${apiUrl(node)}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "X-Session-Token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export interface TestUser {
  client: Client;
  token: string;
  id: string;
  node: StoatNode;
}

/** Create an account, onboard it and connect a stoat.js client. */
export async function register(node: StoatNode, username: string): Promise<TestUser> {
  const email = `${username}@example.test`;
  const password = "correct horse battery";
  const created = await api(node, "POST", "/auth/account/create", { email, password });
  if (created.status !== 204) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const login = await api(node, "POST", "/auth/session/login", { email, password, friendly_name: "test" });
  if (login.body?.result !== "Success") throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  const onboard = await api(node, "POST", "/onboard/complete", { username }, login.body.token);
  if (onboard.status !== 200) throw new Error(`onboard failed: ${JSON.stringify(onboard.body)}`);

  const config = (await api(node, "GET", "/")).body;
  const client = new Client({ baseURL: apiUrl(node), autoReconnect: false }, config);
  client.useExistingSession({ _id: login.body._id, token: login.body.token, user_id: login.body.user_id });
  const ready = new Promise<void>((resolve) => client.once("ready", () => resolve()));
  client.connect();
  await ready;
  clients.push(client);
  return { client, token: login.body.token, id: login.body.user_id, node };
}

export async function cleanup(): Promise<void> {
  for (const client of clients.splice(0)) {
    client.removeAllListeners();
    client.events.removeAllListeners();
    client.events.disconnect();
  }
  // Let requests the SDK started in the background finish before nodes go away.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await Promise.all(nodes.splice(0).map((node) => node.stop()));
}

/** Wait until two nodes see each other as connected peers. */
export async function connected(a: StoatNode, b: StoatNode): Promise<void> {
  await waitFor(
    () => a.p2p.status().peers.some((p) => p.id === b.nodeId && p.connected) && b.p2p.status().peers.some((p) => p.id === a.nodeId && p.connected),
    8000,
    "peers to connect",
  );
}
