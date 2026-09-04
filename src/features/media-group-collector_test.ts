import { deepStrictEqual, strictEqual } from "node:assert";
import { MediaGroupCollector } from "./media-group-collector.ts";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

Deno.test("media groups flush after one idle window and are sorted", async () => {
  const collector = new MediaGroupCollector<{ message_id: number }>({
    idleMs: 25,
    maxAgeMs: 500,
    maxGroups: 10,
    maxItemsPerGroup: 10,
  });

  const second = collector.collect("chat:album", { message_id: 2 });
  await delay(10);
  const first = collector.collect("chat:album", { message_id: 1 });

  deepStrictEqual(await second, [{ message_id: 1 }, { message_id: 2 }]);
  deepStrictEqual(await first, [{ message_id: 1 }, { message_id: 2 }]);
  strictEqual(collector.pendingGroupCount, 0);
});

Deno.test("media groups cannot remain in memory past their maximum age", async () => {
  const collector = new MediaGroupCollector<{ message_id: number }>({
    idleMs: 1_000,
    maxAgeMs: 25,
    maxGroups: 10,
    maxItemsPerGroup: 10,
  });

  deepStrictEqual(await collector.collect("chat:stale", { message_id: 4 }), [
    { message_id: 4 },
  ]);
  strictEqual(collector.pendingGroupCount, 0);
});

Deno.test("media group count is bounded by flushing the oldest group", async () => {
  const collector = new MediaGroupCollector<{ message_id: number }>({
    idleMs: 1_000,
    maxAgeMs: 2_000,
    maxGroups: 1,
    maxItemsPerGroup: 10,
  });

  const oldest = collector.collect("chat:oldest", { message_id: 1 });
  const newest = collector.collect("chat:newest", { message_id: 2 });

  deepStrictEqual(await oldest, [{ message_id: 1 }]);
  strictEqual(collector.pendingGroupCount, 1);

  collector.flush("chat:newest");
  deepStrictEqual(await newest, [{ message_id: 2 }]);
  strictEqual(collector.pendingGroupCount, 0);
});
