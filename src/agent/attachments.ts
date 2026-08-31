import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentJob, JsonObject, JsonValue } from "../shared/types.ts";
import type { GatewayClient } from "./gateway.ts";

const maxAttachmentBytes = 25 * 1024 * 1024;
const maxTotalAttachmentBytes = 100 * 1024 * 1024;
const maxAttachmentCount = 10;

export type StagedAttachment = {
  kind: string;
  fileId: string;
  path: string | null;
  fileName: string | null;
  mimeType: string | null;
  error?: string;
};

type AttachmentReference = {
  kind: string;
  fileId: string;
  fileName: string | null;
  mimeType: string | null;
};

function object(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function stringField(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function reference(kind: string, value: JsonValue): AttachmentReference | null {
  const item = object(value);
  if (!item) {
    return null;
  }
  const fileId = stringField(item.file_id);
  if (!fileId) {
    return null;
  }
  return {
    kind,
    fileId,
    fileName: stringField(item.file_name),
    mimeType: stringField(item.mime_type),
  };
}

export function attachmentReferences(attachments: JsonValue[]): AttachmentReference[] {
  const references: AttachmentReference[] = [];
  const seen = new Set<string>();
  for (const entry of attachments) {
    const item = object(entry);
    if (!item) {
      continue;
    }
    const kind = stringField(item.kind) ?? "attachment";
    const value = item.value;
    if (Array.isArray(value)) {
      // Telegram sends several photo sizes. The last one is normally the largest.
      const candidate = [...value].reverse().find((part) => reference(kind, part));
      const resolved = candidate === undefined ? null : reference(kind, candidate);
      if (resolved && !seen.has(resolved.fileId)) {
        seen.add(resolved.fileId);
        references.push(resolved);
      }
    } else if (value !== undefined) {
      const resolved = reference(kind, value);
      if (resolved && !seen.has(resolved.fileId)) {
        seen.add(resolved.fileId);
        references.push(resolved);
      }
    }
  }
  return references.slice(0, maxAttachmentCount);
}

function safeName(value: string | null, index: number, mimeType: string | null): string {
  const candidate = value ? basename(value) : `attachment-${index + 1}`;
  const cleaned = candidate.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (cleaned.includes(".")) {
    return cleaned;
  }
  const extension = mimeType
    ?.split("/")[1]
    ?.replaceAll(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8);
  return extension ? `${cleaned}.${extension}` : cleaned;
}

async function downloadOne(
  gateway: GatewayClient,
  attachment: AttachmentReference,
  path: string,
): Promise<number> {
  const bytes = await gateway.downloadMedia(attachment.fileId, maxAttachmentBytes);
  if (bytes.byteLength > maxAttachmentBytes) {
    throw new Error(`file is larger than ${maxAttachmentBytes} bytes`);
  }
  await writeFile(path, bytes);
  return bytes.byteLength;
}

export type StagedAttachments = {
  files: StagedAttachment[];
  cleanup: () => Promise<void>;
};

export async function stageAttachments(
  gateway: GatewayClient,
  job: AgentJob,
): Promise<StagedAttachments> {
  const references = attachmentReferences(job.attachments);
  if (references.length === 0) {
    return { files: [], cleanup: async () => {} };
  }

  const directory = await mkdtemp(join(tmpdir(), `loylex-job-${job.id}-`));
  await mkdir(directory, { recursive: true });
  let totalBytes = 0;
  const files: StagedAttachment[] = [];
  try {
    for (const [index, attachment] of references.entries()) {
      const path = join(directory, safeName(attachment.fileName, index, attachment.mimeType));
      try {
        const size = await downloadOne(gateway, attachment, path);
        if (totalBytes + size > maxTotalAttachmentBytes) {
          throw new Error(`total attachment size exceeds ${maxTotalAttachmentBytes} bytes`);
        }
        totalBytes += size;
        files.push({ ...attachment, path });
      } catch (error) {
        files.push({
          ...attachment,
          path: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    files,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
