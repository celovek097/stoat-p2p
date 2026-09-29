// Accounts that live on this node. An account is a local login (email +
// password) for the Stoat client plus the user's signing keys; the email
// never leaves the node. Several people may share one node, like a
// homeserver, but most people will run their own.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  checkPassword,
  generateAgreementKey,
  generateSigningKey,
  hashPassword,
  type KeyPair,
  randomToken,
} from "../core/crypto.ts";
import { userIdFromKey } from "../core/event.ts";
import { randomUlid } from "../core/ulid.ts";

export interface Account {
  id: string;
  email: string;
  password: string;
  keys: KeyPair;
  x25519: KeyPair;
  created: number;
  onboarded: boolean;
  /** Imported from another node: wait for the existing profile instead of publishing a new one */
  imported?: boolean;
}

export interface Session {
  id: string;
  token: string;
  user: string;
  name: string;
  lastSeen: number;
}

export interface Unread {
  last_id?: string;
  mentions: string[];
}

interface AccountsFile {
  accounts: Account[];
  sessions: Session[];
  settings: Record<string, Record<string, [number, string]>>;
  unreads: Record<string, Record<string, Unread>>;
  /** DM channels a user has opened (shown even before the first message) */
  openDms: Record<string, string[]>;
}

export class Accounts {
  readonly #file: string | null;
  #data: AccountsFile = { accounts: [], sessions: [], settings: {}, unreads: {}, openDms: {} };
  #saveTimer: NodeJS.Timeout | undefined;

  constructor(dir: string | null) {
    this.#file = dir ? join(dir, "accounts.json") : null;
    if (dir) mkdirSync(dir, { recursive: true });
    if (this.#file && existsSync(this.#file)) {
      this.#data = { ...this.#data, ...JSON.parse(readFileSync(this.#file, "utf8")) };
    }
  }

  #save(): void {
    if (!this.#file) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.flush(), 200);
  }

  flush(): void {
    if (!this.#file) return;
    clearTimeout(this.#saveTimer);
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 1), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  // Accounts -----------------------------------------------------------------

  list(): Account[] {
    return this.#data.accounts;
  }

  get(user: string): Account | undefined {
    return this.#data.accounts.find((a) => a.id === user);
  }

  byEmail(email: string): Account | undefined {
    const normalised = email.trim().toLowerCase();
    return this.#data.accounts.find((a) => a.email === normalised);
  }

  create(email: string, password: string): Account {
    const keys = generateSigningKey();
    const created = Date.now();
    const account: Account = {
      id: userIdFromKey(keys.pub, created),
      email: email.trim().toLowerCase(),
      password: hashPassword(password),
      keys,
      x25519: generateAgreementKey(),
      created,
      onboarded: false,
    };
    this.#data.accounts.push(account);
    this.#save();
    return account;
  }

  /** Import an existing identity (moving to another node). */
  import(email: string, password: string, keys: KeyPair, x25519: KeyPair, created: number): Account {
    const account: Account = {
      id: userIdFromKey(keys.pub, created),
      email: email.trim().toLowerCase(),
      password: hashPassword(password),
      keys,
      x25519,
      created,
      onboarded: true,
      imported: true,
    };
    this.#data.accounts.push(account);
    this.#save();
    return account;
  }

  update(account: Account, changes: Partial<Account>): void {
    Object.assign(account, changes);
    this.#save();
  }

  verifyPassword(account: Account, password: string): boolean {
    return typeof password === "string" && checkPassword(password, account.password);
  }

  // Sessions -----------------------------------------------------------------

  login(account: Account, name: string): Session {
    const session: Session = { id: randomUlid(), token: randomToken(), user: account.id, name, lastSeen: Date.now() };
    this.#data.sessions.push(session);
    this.#save();
    return session;
  }

  byToken(token: string | undefined | null): { session: Session; account: Account } | undefined {
    if (!token) return undefined;
    const session = this.#data.sessions.find((s) => s.token === token);
    const account = session && this.get(session.user);
    return session && account ? { session, account } : undefined;
  }

  sessionsOf(user: string): Session[] {
    return this.#data.sessions.filter((s) => s.user === user);
  }

  removeSession(id: string): void {
    this.#data.sessions = this.#data.sessions.filter((s) => s.id !== id);
    this.#save();
  }

  renameSession(id: string, name: string): void {
    const session = this.#data.sessions.find((s) => s.id === id);
    if (session) session.name = name;
    this.#save();
  }

  // Settings (/sync/settings) ---------------------------------------------------

  settings(user: string): Record<string, [number, string]> {
    return (this.#data.settings[user] ??= {});
  }

  setSettings(user: string, values: Record<string, string>, timestamp: number): void {
    const settings = this.settings(user);
    for (const [key, value] of Object.entries(values)) {
      const current = settings[key];
      if (!current || current[0] <= timestamp) settings[key] = [timestamp, value];
    }
    this.#save();
  }

  // Unreads -------------------------------------------------------------------

  unreads(user: string): Record<string, Unread> {
    return (this.#data.unreads[user] ??= {});
  }

  ack(user: string, channel: string, message: string): void {
    const unreads = this.unreads(user);
    const entry = (unreads[channel] ??= { mentions: [] });
    if (!entry.last_id || entry.last_id < message) entry.last_id = message;
    entry.mentions = entry.mentions.filter((id) => id > message);
    this.#save();
  }

  mention(user: string, channel: string, message: string): void {
    const entry = (this.unreads(user)[channel] ??= { mentions: [] });
    if (!entry.mentions.includes(message) && (!entry.last_id || entry.last_id < message)) {
      entry.mentions.push(message);
      this.#save();
    }
  }

  // Direct messages -------------------------------------------------------------

  openDms(user: string): string[] {
    return (this.#data.openDms[user] ??= []);
  }

  openDm(user: string, channel: string): boolean {
    const list = this.openDms(user);
    if (list.includes(channel)) return false;
    list.push(channel);
    this.#save();
    return true;
  }
}
