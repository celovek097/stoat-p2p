import { randomBytes } from "node:crypto";

import { generateSigningKey } from "../src/core/crypto.ts";
import { createEvent, type Signer, serverIdFrom, serverScope, type StoatEvent, userIdFromKey } from "../src/core/event.ts";

export function makeUser(createdAt = Date.now()): Signer {
  const keys = generateSigningKey();
  return { user: userIdFromKey(keys.pub, createdAt), keys };
}

export function genesis(owner: Signer, name = "Test", ts = Date.now()): { event: StoatEvent; server: string } {
  const nonce = randomBytes(8).toString("hex");
  const server = serverIdFrom(ts, owner.keys.pub, nonce);
  const event = createEvent(
    owner,
    serverScope(server),
    "server.create",
    { nonce, name, channels: [{ name: "General", type: "Text" }], system_messages: true },
    [],
    ts,
  );
  return { event, server };
}

/** Deterministic Fisher-Yates shuffle that keeps causal order valid. */
export function causalShuffle(events: StoatEvent[], seed: number): StoatEvent[] {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const remaining = [...events];
  const done = new Set<string>();
  const out: StoatEvent[] = [];
  while (remaining.length) {
    const ready = remaining.filter((e) => e.deps.every((d) => done.has(d)));
    const pick = ready[Math.floor(random() * ready.length)]!;
    remaining.splice(remaining.indexOf(pick), 1);
    done.add(pick.id);
    out.push(pick);
  }
  return out;
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeout = 8000, what = "condition"): Promise<NonNullable<T>> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}
