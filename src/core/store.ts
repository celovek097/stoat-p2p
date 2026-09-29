// Append-only event log. The log *is* the database: state is rebuilt from it
// on start-up and it is what gets replicated between nodes.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256hex } from "./crypto.ts";
import { bucketOf, type StoatEvent } from "./event.ts";

interface ScopeIndex {
  ids: Set<string>;
  buckets: Map<number, Set<string>>;
  digests: Map<number, string>;
}

export class EventStore {
  readonly #file: string | null;
  readonly #events = new Map<string, StoatEvent>();
  readonly #scopes = new Map<string, ScopeIndex>();

  constructor(dir: string | null) {
    if (dir) {
      mkdirSync(dir, { recursive: true });
      this.#file = join(dir, "events.jsonl");
    } else {
      this.#file = null;
    }
  }

  /** Read every persisted event in the order it was appended. */
  load(): StoatEvent[] {
    if (!this.#file || !existsSync(this.#file)) return [];
    const events: StoatEvent[] = [];
    for (const line of readFileSync(this.#file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // A torn final line after a crash is skipped.
      }
    }
    return events;
  }

  get size(): number {
    return this.#events.size;
  }

  has(id: string): boolean {
    return this.#events.has(id);
  }

  get(id: string): StoatEvent | undefined {
    return this.#events.get(id);
  }

  /** Add an event to the in-memory index and optionally persist it. */
  add(event: StoatEvent, persist = true): void {
    if (this.#events.has(event.id)) return;
    this.#events.set(event.id, event);
    let index = this.#scopes.get(event.scope);
    if (!index) {
      index = { ids: new Set(), buckets: new Map(), digests: new Map() };
      this.#scopes.set(event.scope, index);
    }
    index.ids.add(event.id);
    const bucket = bucketOf(event.ts);
    let ids = index.buckets.get(bucket);
    if (!ids) {
      ids = new Set();
      index.buckets.set(bucket, ids);
    }
    ids.add(event.id);
    index.digests.delete(bucket);
    if (persist && this.#file) appendFileSync(this.#file, `${JSON.stringify(event)}\n`);
  }

  scopes(): string[] {
    return [...this.#scopes.keys()];
  }

  hasScope(scope: string): boolean {
    return this.#scopes.has(scope);
  }

  scopeEvents(scope: string): StoatEvent[] {
    const index = this.#scopes.get(scope);
    if (!index) return [];
    return [...index.ids].map((id) => this.#events.get(id)!);
  }

  /** Per-day summary of a scope: bucket -> [count, digest]. */
  summary(scope: string): Record<string, [number, string]> {
    const index = this.#scopes.get(scope);
    const out: Record<string, [number, string]> = {};
    if (!index) return out;
    for (const [bucket, ids] of index.buckets) {
      let digest = index.digests.get(bucket);
      if (!digest) {
        digest = sha256hex([...ids].sort().join("")).slice(0, 32);
        index.digests.set(bucket, digest);
      }
      out[bucket] = [ids.size, digest];
    }
    return out;
  }

  bucketIds(scope: string, bucket: number): string[] {
    return [...(this.#scopes.get(scope)?.buckets.get(bucket) ?? [])];
  }
}
