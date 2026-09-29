// One connection to another node (inbound or outbound). Both sides prove
// ownership of their node key and of the user keys they host by signing a
// fresh challenge chosen by the other side.

import { randomBytes } from "node:crypto";

import type { WebSocket } from "ws";

import { b64u, type KeyPair, signData, verifyData } from "../core/crypto.ts";
import { keyMatchesUser } from "../core/event.ts";

export const PROTOCOL = "stoat-p2p/1";

export interface UserProof {
  id: string;
  key: string;
  sig: string;
}

/** A user's permission for a relay node to sync on their behalf. */
export interface Delegation {
  user: string;
  key: string;
  node: string;
  exp: number;
  sig: string;
}

export interface Hello {
  t: "hello";
  proto: string;
  node: string;
  name: string;
  challenge: string;
  announce: string[];
  relay: boolean;
}

export interface Auth {
  t: "auth";
  sig: string;
  /** Users hosted by the sender, proved against our challenge */
  users: UserProof[];
  /** Delegations to the sender: users it may act for (sender is a relay) */
  delegations: Delegation[];
  /** Delegations from the sender's users to us (we are a relay) */
  grants: Delegation[];
}

export type Frame = { t: string; [key: string]: unknown };

export const authMessage = (challenge: string, from: string, to: string) => `stoat-p2p/auth/${challenge}/${from}/${to}`;
export const representMessage = (challenge: string, node: string) => `stoat-p2p/represent/${challenge}/${node}`;
export const delegationMessage = (node: string, exp: number) => `stoat-p2p/delegate/${node}/${exp}`;

export function proveUser(user: string, keys: KeyPair, challenge: string, node: string): UserProof {
  return { id: user, key: keys.pub, sig: signData(keys, representMessage(challenge, node)) };
}

export function delegate(user: string, keys: KeyPair, node: string, days = 7): Delegation {
  const exp = Date.now() + days * 86_400_000;
  return { user, key: keys.pub, node, exp, sig: signData(keys, delegationMessage(node, exp)) };
}

export function verifyDelegation(d: Delegation, node: string): boolean {
  return (
    typeof d === "object" &&
    d !== null &&
    d.node === node &&
    typeof d.exp === "number" &&
    d.exp > Date.now() &&
    keyMatchesUser(d.key, d.user) &&
    verifyData(d.key, delegationMessage(node, d.exp), d.sig)
  );
}

export class Peer {
  readonly ws: WebSocket;
  /** URL we dialled (undefined for inbound connections) */
  readonly url: string | undefined;
  readonly challenge = b64u(randomBytes(32));
  hello: Hello | undefined;
  ready = false;
  /** Users hosted by the peer (proved in the handshake) */
  readonly users = new Set<string>();
  /** Users the peer may act for through delegations (relays) */
  readonly delegations = new Map<string, Delegation>();
  /** Scopes the peer asked us to keep it updated about */
  readonly subscriptions = new Set<string>();
  /** Invite codes presented by the peer, per scope */
  readonly invites = new Map<string, string>();
  lastSeen = Date.now();
  alive = true;

  constructor(ws: WebSocket, url?: string) {
    this.ws = ws;
    this.url = url;
  }

  get id(): string {
    return this.hello?.node ?? "";
  }

  send(frame: Frame): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame));
  }

  /** Whether the peer hosts, or relays for, the given user. */
  represents(user: string): boolean {
    if (this.users.has(user)) return true;
    const d = this.delegations.get(user);
    return !!d && d.exp > Date.now();
  }

  representedUsers(): string[] {
    return [...new Set([...this.users, ...[...this.delegations.values()].filter((d) => d.exp > Date.now()).map((d) => d.user)])];
  }

  /** Validate the peer's auth frame; returns an error or null. */
  verifyAuth(auth: Auth, ownNode: string, onGrant?: (d: Delegation) => void, usersOnly = false): string | null {
    const hello = this.hello;
    if (!hello) return "auth before hello";
    if (!usersOnly && !verifyData(hello.node, authMessage(this.challenge, hello.node, ownNode), auth.sig)) {
      return "bad node signature";
    }
    for (const proof of Array.isArray(auth.users) ? auth.users.slice(0, 1000) : []) {
      if (keyMatchesUser(proof.key, proof.id) && verifyData(proof.key, representMessage(this.challenge, hello.node), proof.sig)) {
        this.users.add(proof.id);
      }
    }
    for (const d of Array.isArray(auth.delegations) ? auth.delegations.slice(0, 10_000) : []) {
      if (verifyDelegation(d, hello.node)) this.delegations.set(d.user, d);
    }
    for (const d of Array.isArray(auth.grants) ? auth.grants.slice(0, 1000) : []) {
      if (verifyDelegation(d, ownNode) && this.users.has(d.user)) onGrant?.(d);
    }
    return null;
  }
}
