import type { Insertable, Selectable } from "@kysely/kysely";
import { type Api, InputFile } from "grammy";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";

export type ImagesTable = {
  id: string;
  file_id: string;
  created_at: string;
};

export type StoredImage = Selectable<ImagesTable>;

export type ImageSource = {
  url?: string;
  dataUrl?: string;
  mimeType?: string;
};

export type RichMessagePhotoMedia = {
  id: string;
  media: {
    type: "photo";
    media: string;
  };
};

const IMAGE_REFERENCE_PATTERN = /tg:\/\/photo\?id=([A-Za-z0-9_-]{1,64})/g;

export async function migrateImages(database: Database): Promise<void> {
  await database.schema
    .createTable("images")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey().notNull())
    .addColumn("file_id", "text", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.notNull())
    .execute();
}

function getHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function getImageFileExtension(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function createImageInput(source: ImageSource): string | InputFile {
  const url = getHttpUrl(source.url);

  if (url) {
    return url;
  }

  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(
    source.dataUrl ?? "",
  );

  if (!match) {
    throw new Error("Image source does not contain an HTTP URL or image data.");
  }

  const mimeType = source.mimeType ?? match[1];
  const extension = getImageFileExtension(mimeType);
  return new InputFile(decodeBase64(match[2]), `cached-image.${extension}`);
}

function createImageId(): string {
  return `image_${crypto.randomUUID().replaceAll("-", "")}`;
}

function getMediaCacheChatId(): number {
  if (APP_ENV.MEDIA_CACHE_CHAT_ID === undefined) {
    throw new Error("MEDIA_CACHE_CHAT_ID is not set.");
  }

  return APP_ENV.MEDIA_CACHE_CHAT_ID;
}

export async function saveImage(
  database: Database,
  api: Api,
  source: ImageSource,
): Promise<StoredImage> {
  const sentMessage = await api.sendPhoto(
    getMediaCacheChatId(),
    createImageInput(source),
  );
  const photo = sentMessage.photo.toSorted(
    (left, right) => right.width * right.height - left.width * left.height,
  )[0];

  if (!photo) {
    throw new Error("Telegram media cache response did not contain a photo.");
  }

  const image: Insertable<ImagesTable> = {
    id: createImageId(),
    file_id: photo.file_id,
    created_at: new Date().toISOString(),
  };

  await database.insertInto("images").values(image).execute();

  return image;
}

export function getRichMessageImageIds(markdown: string): string[] {
  const ids = Array.from(
    markdown.matchAll(IMAGE_REFERENCE_PATTERN),
    (match) => match[1],
  );
  return [...new Set(ids)];
}

export async function resolveRichMessageImageMedia(
  database: Database,
  markdown: string,
): Promise<RichMessagePhotoMedia[]> {
  const ids = getRichMessageImageIds(markdown);

  if (ids.length === 0) {
    return [];
  }

  const images = await database
    .selectFrom("images")
    .select(["id", "file_id"])
    .where("id", "in", ids)
    .execute();
  const imagesById = new Map(images.map((image) => [image.id, image]));
  const missingIds = ids.filter((id) => !imagesById.has(id));

  if (missingIds.length > 0) {
    throw new Error(`Unknown image id(s): ${missingIds.join(", ")}`);
  }

  return ids.map((id) => {
    const image = imagesById.get(id);

    if (!image) {
      throw new Error(`Unknown image id: ${id}`);
    }

    return {
      id,
      media: {
        type: "photo",
        media: image.file_id,
      },
    };
  });
}
