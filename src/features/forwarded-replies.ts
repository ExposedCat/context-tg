export type ForwardedMessage = {
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_sender_name?: string;
  forward_date?: number;
};

export function isForwardedMessage(message: ForwardedMessage): boolean {
  return (
    message.forward_origin !== undefined ||
    message.forward_from !== undefined ||
    message.forward_from_chat !== undefined ||
    message.forward_sender_name !== undefined ||
    message.forward_date !== undefined
  );
}

const FORWARD_BATCH_IDLE_MS = 2_000;
const MAX_FORWARDS_PER_BATCH = 10;

type ForwardBatch<T> = {
  posts: T[];
  done: PromiseWithResolvers<void>;
  timer?: ReturnType<typeof setTimeout>;
};

type ForwardQueue<T> = {
  collecting?: ForwardBatch<T>;
  processing?: Promise<void>;
};

export class ForwardBatcher<T> {
  readonly #queues = new Map<string, ForwardQueue<T>>();

  constructor(private readonly processBatch: (posts: T[]) => Promise<void>) {}

  add(key: string, post: T): Promise<void> {
    let queue = this.#queues.get(key);
    if (!queue) {
      queue = {};
      this.#queues.set(key, queue);
    }
    queue.collecting ??= {
      posts: [],
      done: Promise.withResolvers<void>(),
    };
    const batch = queue.collecting;
    batch.posts.push(post);
    clearTimeout(batch.timer);

    if (batch.posts.length === MAX_FORWARDS_PER_BATCH) {
      this.#flush(key, queue, batch);
    } else {
      batch.timer = setTimeout(
        () => this.#flush(key, queue, batch),
        FORWARD_BATCH_IDLE_MS,
      );
    }
    return batch.done.promise;
  }

  #flush(key: string, queue: ForwardQueue<T>, batch: ForwardBatch<T>): void {
    queue.collecting = undefined;
    const processing = (queue.processing ?? Promise.resolve())
      .then(() => this.processBatch(batch.posts))
      .then(batch.done.resolve, batch.done.reject);
    queue.processing = processing;
    void processing.then(() => {
      if (!queue.collecting && queue.processing === processing) {
        this.#queues.delete(key);
      }
    });
  }
}
