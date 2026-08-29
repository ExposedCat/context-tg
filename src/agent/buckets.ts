import { isAbsolute, join, normalize } from "node:path";

type Bucket = {
  file: string;
  always?: boolean;
  terms?: string[];
};

type BucketIndex = {
  buckets: Bucket[];
};

function safePath(root: string, relative: string): string | null {
  if (isAbsolute(relative)) {
    return null;
  }
  const resolved = normalize(join(root, relative));
  return resolved.startsWith(`${normalize(root)}/`) ? resolved : null;
}

export async function loadBuckets(memoryPath: string, input: string): Promise<string> {
  const bucketRoot = join(memoryPath, "buckets");
  const indexFile = Bun.file(join(bucketRoot, "index.json"));
  if (!(await indexFile.exists())) {
    return "";
  }
  const index = (await indexFile.json()) as BucketIndex;
  const normalizedInput = input.toLocaleLowerCase();
  const selected = index.buckets.filter(
    (bucket) =>
      bucket.always ||
      bucket.terms?.some((term) => normalizedInput.includes(term.toLocaleLowerCase())),
  );
  const contents: string[] = [];
  for (const bucket of selected) {
    const path = safePath(bucketRoot, bucket.file);
    if (!path) {
      continue;
    }
    const file = Bun.file(path);
    if (await file.exists()) {
      contents.push(`## Memory bucket: ${bucket.file}\n\n${await file.text()}`);
    }
  }
  return contents.join("\n\n");
}
