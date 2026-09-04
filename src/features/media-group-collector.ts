export type MediaGroupItem = {
  message_id: number;
};

export type MediaGroupCollectorOptions = {
  idleMs: number;
  maxAgeMs: number;
  maxGroups: number;
  maxItemsPerGroup: number;
};

type PendingMediaGroup<T extends MediaGroupItem> = {
  createdAt: number;
  items: Map<number, T>;
  waiters: Array<(items: T[]) => void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  expiryTimer: ReturnType<typeof setTimeout>;
};

/**
 * Collects separately delivered Telegram media-group messages until the group
 * has been idle for a configured period. A hard age and size limits keep a
 * malformed or continuously active group from being retained indefinitely.
 */
export class MediaGroupCollector<T extends MediaGroupItem> {
  readonly #groups = new Map<string, PendingMediaGroup<T>>();

  constructor(readonly options: MediaGroupCollectorOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite number`);
      }
    }
  }

  get pendingGroupCount(): number {
    return this.#groups.size;
  }

  collect(key: string, item: T): Promise<T[]> {
    let group = this.#groups.get(key);

    if (!group) {
      this.#makeRoomForGroup();
      group = this.#createGroup(key);
      this.#groups.set(key, group);
    }

    group.items.set(item.message_id, item);

    if (group.idleTimer) {
      clearTimeout(group.idleTimer);
    }
    group.idleTimer = setTimeout(() => this.flush(key), this.options.idleMs);

    return new Promise<T[]>((resolve) => {
      group.waiters.push(resolve);

      if (group.items.size >= this.options.maxItemsPerGroup) {
        this.flush(key);
      }
    });
  }

  flush(key: string): boolean {
    const group = this.#groups.get(key);

    if (!group) {
      return false;
    }

    this.#groups.delete(key);
    if (group.idleTimer) {
      clearTimeout(group.idleTimer);
    }
    clearTimeout(group.expiryTimer);

    const items = [...group.items.values()].sort(
      (left, right) => left.message_id - right.message_id,
    );
    for (const resolve of group.waiters) {
      resolve(items);
    }

    return true;
  }

  #createGroup(key: string): PendingMediaGroup<T> {
    return {
      createdAt: Date.now(),
      items: new Map(),
      waiters: [],
      expiryTimer: setTimeout(() => this.flush(key), this.options.maxAgeMs),
    };
  }

  #makeRoomForGroup(): void {
    if (this.#groups.size < this.options.maxGroups) {
      return;
    }

    let oldestKey: string | undefined;
    let oldestCreatedAt = Number.POSITIVE_INFINITY;

    for (const [key, group] of this.#groups) {
      if (group.createdAt < oldestCreatedAt) {
        oldestKey = key;
        oldestCreatedAt = group.createdAt;
      }
    }

    if (oldestKey) {
      this.flush(oldestKey);
    }
  }
}
