import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBuckets } from "../src/agent/buckets.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loads always and term-selected private buckets", async () => {
  const root = mkdtempSync(join(tmpdir(), "loylex-memory-"));
  directories.push(root);
  const buckets = join(root, "buckets");
  await Bun.write(
    join(buckets, "index.json"),
    JSON.stringify({
      buckets: [
        { file: "identity.md", always: true },
        { file: "servers.md", terms: ["VPS", "сервер"] },
        { file: "music.md", terms: ["music"] },
      ],
    }),
  );
  await Bun.write(join(buckets, "identity.md"), "I am Loylex");
  await Bun.write(join(buckets, "servers.md"), "Private server notes");
  await Bun.write(join(buckets, "music.md"), "Private music notes");

  const selected = await loadBuckets(root, "Покажи статус СЕРВЕРА");
  expect(selected).toContain("I am Loylex");
  expect(selected).toContain("Private server notes");
  expect(selected).not.toContain("Private music notes");
});
