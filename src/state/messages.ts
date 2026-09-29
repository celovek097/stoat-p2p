import type { MessageData } from "./types.ts";

export interface MessageQuery {
  limit?: number;
  before?: string;
  after?: string;
  sort?: "Latest" | "Oldest" | "Relevance";
  nearby?: string;
  pinned?: boolean;
  search?: string;
}

/** Messages of one channel, kept sorted by id (= by time). */
export class ChannelMessages {
  readonly byId = new Map<string, MessageData>();
  #sorted: string[] = [];

  get(id: string): MessageData | undefined {
    return this.byId.get(id);
  }

  add(message: MessageData): void {
    if (this.byId.has(message.id)) return;
    this.byId.set(message.id, message);
    const ids = this.#sorted;
    if (!ids.length || ids[ids.length - 1]! < message.id) {
      ids.push(message.id);
      return;
    }
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid]! < message.id) lo = mid + 1;
      else hi = mid;
    }
    ids.splice(lo, 0, message.id);
  }

  remove(id: string): void {
    if (!this.byId.delete(id)) return;
    const index = this.#sorted.indexOf(id);
    if (index >= 0) this.#sorted.splice(index, 1);
  }

  #visible(id: string): MessageData | undefined {
    const message = this.byId.get(id);
    return message && !message.deleted && !message.hidden ? message : undefined;
  }

  /** Id of the newest visible message. */
  lastId(): string | undefined {
    for (let i = this.#sorted.length - 1; i >= 0; i--) {
      if (this.#visible(this.#sorted[i]!)) return this.#sorted[i];
    }
    return undefined;
  }

  visibleCount(): number {
    let count = 0;
    for (const id of this.#sorted) if (this.#visible(id)) count++;
    return count;
  }

  query(options: MessageQuery): MessageData[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const matches = (m: MessageData) =>
      (options.pinned === undefined || !!m.pinned === options.pinned) &&
      (!options.search || (m.content ?? "").toLowerCase().includes(options.search.toLowerCase()));

    if (options.nearby) {
      const half = Math.floor(limit / 2) + 1;
      const newer: MessageData[] = [];
      const older: MessageData[] = [];
      for (const id of this.#sorted) {
        const m = this.#visible(id);
        if (!m || !matches(m)) continue;
        if (id >= options.nearby) {
          if (newer.length < half) newer.push(m);
        }
      }
      for (let i = this.#sorted.length - 1; i >= 0; i--) {
        const id = this.#sorted[i]!;
        const m = this.#visible(id);
        if (!m || !matches(m) || id >= options.nearby) continue;
        older.push(m);
        if (older.length >= half) break;
      }
      return [...newer, ...older];
    }

    const oldest = options.sort === "Oldest";
    const out: MessageData[] = [];
    const ids = this.#sorted;
    for (let n = 0; n < ids.length && out.length < limit; n++) {
      const id = oldest ? ids[n]! : ids[ids.length - 1 - n]!;
      if (options.before && !(id < options.before)) continue;
      if (options.after && !(id > options.after)) continue;
      const m = this.#visible(id);
      if (m && matches(m)) out.push(m);
    }
    return out;
  }
}
