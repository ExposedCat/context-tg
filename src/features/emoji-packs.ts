import { createDebug } from "@grammyjs/debug";
import { type Insertable, type Selectable, sql } from "@kysely/kysely";
import { Composer, type Transformer } from "grammy";
import type { Context } from "../bot.ts";
import { escapeHtml, escapeHtmlAttribute } from "../utils/text.ts";
import type { Database } from "./database.ts";
import { APP_ENV } from "./env.ts";

export type EmojiPacksTable = {
  name: string;
  position: number;
  created_at: string;
};

type EmojiPack = Selectable<EmojiPacksTable>;
type CreateEmojiPack = Insertable<EmojiPacksTable>;
type EmojiPacksDatabase = Pick<
  Database,
  | "deleteFrom"
  | "insertInto"
  | "schema"
  | "selectFrom"
  | "transaction"
  | "updateTable"
>;

type StickerSet = {
  sticker_type: string;
  stickers: Array<{
    custom_emoji_id?: string;
    emoji?: string;
  }>;
};

type StickerSetReader = {
  getStickerSet(name: string, signal?: AbortSignal): Promise<StickerSet>;
};

type EmojiReplacement = {
  emoji: string;
  fallback: string;
  id: string;
};

type EmojiRegistry = {
  replacements: EmojiReplacement[];
};

type MarkdownLinkMatch = {
  destination: string;
  end: number;
  isImage: boolean;
  label: string;
};

type MessageEntity = {
  type: string;
  offset: number;
  length: number;
  custom_emoji_id?: string;
};

type ApiPayload = Record<string, unknown>;

const logDebug = createDebug("app:emoji-packs:debug");
const logError = createDebug("app:emoji-packs:error");

const PACK_NAME_PATTERN = /^[a-zA-Z0-9_]{1,128}$/;
const HTML_CUSTOM_EMOJI_OPEN_PATTERN = /^<tg-emoji(?:\s|>)/i;
const VARIATION_SELECTOR_16 = "\uFE0F";

let registryPromise: Promise<EmojiRegistry> | undefined;

export const emojiPacksComposer = new Composer<Context>();

export async function migrateEmojiPacks(database: Database) {
  await database.schema
    .createTable("emoji_packs")
    .ifNotExists()
    .addColumn("name", "text", (column) => column.primaryKey().notNull())
    .addColumn("position", "integer", (column) => column.notNull())
    .addColumn("created_at", "text", (column) => column.notNull())
    .execute();
}

function invalidateEmojiRegistry() {
  registryPromise = undefined;
}

function getCodePointLength(text: string, index: number): number {
  const codePoint = text.codePointAt(index);
  return codePoint && codePoint > 0xffff ? 2 : 1;
}

function isRecord(value: unknown): value is ApiPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDeletedRowCount(result: { numDeletedRows?: bigint | number }) {
  return Number(result.numDeletedRows ?? 0);
}

function getPackNameFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase();

    if (hostname !== "t.me" && hostname !== "telegram.me") {
      return undefined;
    }

    const [, kind, name] = url.pathname.split("/");

    if (kind !== "addemoji" && kind !== "addstickers") {
      return undefined;
    }

    return name ? decodeURIComponent(name) : undefined;
  } catch {
    return undefined;
  }
}

function parsePackName(args: string): string | undefined {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 1) {
    return undefined;
  }

  const name = getPackNameFromUrl(parts[0]) ?? parts[0];
  return PACK_NAME_PATTERN.test(name) ? name : undefined;
}

function getPackCommandUsage(command: "pack_add" | "pack_remove"): string {
  return `Usage: /${command} NAME`;
}

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === APP_ENV.ADMIN_ID;
}

function formatEmojiPacksList(packs: EmojiPack[]): string {
  if (packs.length === 0) {
    return "No active emoji packs.";
  }

  return [
    "Active emoji packs:",
    ...packs.map((pack, index) => `${index + 1}. ${pack.name}`),
  ].join("\n");
}

export async function listEmojiPacks(
  database: EmojiPacksDatabase,
): Promise<EmojiPack[]> {
  return await database
    .selectFrom("emoji_packs")
    .selectAll()
    .orderBy("position", "asc")
    .execute();
}

async function createEmojiPack(
  database: EmojiPacksDatabase,
  name: string,
): Promise<"created" | "exists"> {
  return await database.transaction().execute(async (transaction) => {
    const existing = await transaction
      .selectFrom("emoji_packs")
      .select("name")
      .where("name", "=", name)
      .executeTakeFirst();

    if (existing) {
      return "exists";
    }

    const row = await transaction
      .selectFrom("emoji_packs")
      .select(sql<number>`coalesce(max(position), -1)`.as("max_position"))
      .executeTakeFirst();
    const pack: CreateEmojiPack = {
      name,
      position: Number(row?.max_position ?? -1) + 1,
      created_at: new Date().toISOString(),
    };

    await transaction.insertInto("emoji_packs").values(pack).execute();

    return "created";
  });
}

async function removeEmojiPack(
  database: EmojiPacksDatabase,
  name: string,
): Promise<boolean> {
  return await database.transaction().execute(async (transaction) => {
    const result = await transaction
      .deleteFrom("emoji_packs")
      .where("name", "=", name)
      .executeTakeFirst();

    if (getDeletedRowCount(result) === 0) {
      return false;
    }

    const packs = await transaction
      .selectFrom("emoji_packs")
      .select("name")
      .orderBy("position", "asc")
      .execute();

    for (const [position, pack] of packs.entries()) {
      await transaction
        .updateTable("emoji_packs")
        .set({ position })
        .where("name", "=", pack.name)
        .execute();
    }

    return true;
  });
}

function getEmojiAliases(emoji: string): string[] {
  const aliases = [emoji];
  const withoutVariationSelector = emoji.replaceAll(VARIATION_SELECTOR_16, "");

  if (withoutVariationSelector && withoutVariationSelector !== emoji) {
    aliases.push(withoutVariationSelector);
  }

  return aliases;
}

async function validateEmojiPack(
  api: StickerSetReader,
  name: string,
): Promise<number> {
  const stickerSet = await api.getStickerSet(name);
  const emojiCount = stickerSet.stickers.filter(
    (sticker) => sticker.custom_emoji_id && sticker.emoji,
  ).length;

  if (stickerSet.sticker_type !== "custom_emoji" || emojiCount === 0) {
    throw new Error("Sticker set is not a custom emoji pack.");
  }

  return emojiCount;
}

async function loadEmojiRegistry(
  database: EmojiPacksDatabase,
  api: StickerSetReader,
): Promise<EmojiRegistry> {
  const replacements: EmojiReplacement[] = [];
  const seenEmoji = new Set<string>();
  const packs = await listEmojiPacks(database);

  for (const pack of packs) {
    try {
      const stickerSet = await api.getStickerSet(pack.name);

      if (stickerSet.sticker_type !== "custom_emoji") {
        logDebug("Skipping non-custom emoji sticker set", { name: pack.name });
        continue;
      }

      for (const sticker of stickerSet.stickers) {
        const id = sticker.custom_emoji_id;
        const fallback = sticker.emoji;

        if (!id || !fallback) {
          continue;
        }

        for (const emoji of getEmojiAliases(fallback)) {
          if (seenEmoji.has(emoji)) {
            continue;
          }

          seenEmoji.add(emoji);
          replacements.push({ emoji, fallback, id });
        }
      }
    } catch (error) {
      logError("Failed to load emoji pack", { name: pack.name, error });
    }
  }

  replacements.sort((left, right) => right.emoji.length - left.emoji.length);
  return { replacements };
}

async function getEmojiRegistry(
  database: EmojiPacksDatabase,
  api: StickerSetReader,
): Promise<EmojiRegistry> {
  registryPromise ??= loadEmojiRegistry(database, api);

  try {
    return await registryPromise;
  } catch (error) {
    registryPromise = undefined;
    throw error;
  }
}

function findEmojiReplacementAt(
  text: string,
  index: number,
  registry: EmojiRegistry,
): EmojiReplacement | undefined {
  return registry.replacements.find((replacement) =>
    text.startsWith(replacement.emoji, index),
  );
}

function findExactEmojiReplacement(
  text: string,
  registry: EmojiRegistry,
): EmojiReplacement | undefined {
  const replacement = findEmojiReplacementAt(text, 0, registry);
  return replacement?.emoji.length === text.length ? replacement : undefined;
}

function hasReplacementCandidates(payload: ApiPayload): boolean {
  if (typeof payload.text === "string" || typeof payload.caption === "string") {
    return true;
  }

  if (!isRecord(payload.rich_message)) {
    return false;
  }

  return (
    typeof payload.rich_message.markdown === "string" ||
    typeof payload.rich_message.html === "string"
  );
}

function getEntitySkipRanges(entities: unknown): Array<{
  start: number;
  end: number;
}> {
  if (!Array.isArray(entities)) {
    return [];
  }

  return entities
    .filter(
      (entity): entity is MessageEntity =>
        isRecord(entity) &&
        typeof entity.offset === "number" &&
        typeof entity.length === "number",
    )
    .map((entity) => ({
      start: entity.offset,
      end: entity.offset + entity.length,
    }))
    .sort((left, right) => left.start - right.start);
}

function overlapsRange(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function getCustomEmojiEntities(
  text: string,
  registry: EmojiRegistry,
  existingEntities: unknown,
): MessageEntity[] {
  const skipRanges = getEntitySkipRanges(existingEntities);
  const entities: MessageEntity[] = [];
  let index = 0;

  while (index < text.length) {
    const replacement = findEmojiReplacementAt(text, index, registry);

    if (replacement) {
      const end = index + replacement.emoji.length;

      if (!overlapsRange(index, end, skipRanges)) {
        entities.push({
          type: "custom_emoji",
          offset: index,
          length: replacement.emoji.length,
          custom_emoji_id: replacement.id,
        });
      }

      index = end;
      continue;
    }

    index += getCodePointLength(text, index);
  }

  return entities;
}

function withCustomEmojiEntities(
  payload: ApiPayload,
  textField: "text" | "caption",
  entityField: "entities" | "caption_entities",
  registry: EmojiRegistry,
): ApiPayload {
  const text = payload[textField];

  if (typeof text !== "string") {
    return payload;
  }

  let existingEntitiesChanged = false;
  const existingEntities = Array.isArray(payload[entityField])
    ? payload[entityField].map((entity) => {
        if (
          !isRecord(entity) ||
          entity.type !== "custom_emoji" ||
          typeof entity.offset !== "number" ||
          typeof entity.length !== "number"
        ) {
          return entity;
        }

        const replacement = findExactEmojiReplacement(
          text.slice(entity.offset, entity.offset + entity.length),
          registry,
        );

        if (!replacement || entity.custom_emoji_id === replacement.id) {
          return entity;
        }

        existingEntitiesChanged = true;
        return { ...entity, custom_emoji_id: replacement.id };
      })
    : [];
  const addedEntities = getCustomEmojiEntities(
    text,
    registry,
    existingEntities,
  );

  if (addedEntities.length === 0 && !existingEntitiesChanged) {
    return payload;
  }

  return {
    ...payload,
    [entityField]: [...existingEntities, ...addedEntities].sort(
      (left, right) =>
        Number((left as MessageEntity).offset ?? 0) -
        Number((right as MessageEntity).offset ?? 0),
    ),
  };
}

function formatHtmlCustomEmoji(replacement: EmojiReplacement): string {
  return `<tg-emoji emoji-id="${escapeHtmlAttribute(replacement.id)}">${escapeHtml(
    replacement.fallback,
  )}</tg-emoji>`;
}

function replaceHtmlEmoji(text: string, registry: EmojiRegistry): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] === "<") {
      const lowerRest = text.slice(index).toLocaleLowerCase();

      if (HTML_CUSTOM_EMOJI_OPEN_PATTERN.test(lowerRest)) {
        const closeIndex = lowerRest.indexOf("</tg-emoji>");

        if (closeIndex >= 0) {
          const tagEnd = text.indexOf(">", index + 1);
          const end = index + closeIndex + "</tg-emoji>".length;

          if (tagEnd >= 0 && tagEnd < end) {
            const fallback = text.slice(tagEnd + 1, index + closeIndex);
            const replacement = findExactEmojiReplacement(fallback, registry);

            result += replacement
              ? formatHtmlCustomEmoji(replacement)
              : text.slice(index, end);
          } else {
            result += text.slice(index, end);
          }

          index = end;
          continue;
        }
      }

      const tagEnd = text.indexOf(">", index + 1);

      if (tagEnd >= 0) {
        result += text.slice(index, tagEnd + 1);
        index = tagEnd + 1;
        continue;
      }
    }

    if (text[index] === "&") {
      const entityEnd = text.indexOf(";", index + 1);

      if (entityEnd >= 0) {
        result += text.slice(index, entityEnd + 1);
        index = entityEnd + 1;
        continue;
      }
    }

    const replacement = findEmojiReplacementAt(text, index, registry);

    if (replacement) {
      result += formatHtmlCustomEmoji(replacement);
      index += replacement.emoji.length;
      continue;
    }

    const length = getCodePointLength(text, index);
    result += text.slice(index, index + length);
    index += length;
  }

  return result;
}

function findMarkdownInlineCodeEnd(text: string, index: number): number {
  let tickCount = 0;

  while (text[index + tickCount] === "`") {
    tickCount++;
  }

  const marker = "`".repeat(tickCount);
  const end = text.indexOf(marker, index + tickCount);
  return end >= 0 ? end + tickCount : index + tickCount;
}

function findMarkdownFenceEnd(text: string, index: number): number {
  const end = text.indexOf("```", index + 3);
  return end >= 0 ? end + 3 : text.length;
}

function findMarkdownLinkMatch(
  text: string,
  index: number,
): MarkdownLinkMatch | undefined {
  const isImage = text[index] === "!";
  const labelStart = text[index] === "!" ? index + 1 : index;

  if (text[labelStart] !== "[") {
    return undefined;
  }

  let cursor = labelStart + 1;

  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }

    if (text[cursor] === "]") {
      break;
    }

    cursor += getCodePointLength(text, cursor);
  }

  if (text[cursor] !== "]" || text[cursor + 1] !== "(") {
    return undefined;
  }

  const label = text.slice(labelStart + 1, cursor);
  const destinationStart = cursor + 2;
  cursor += 2;

  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }

    if (text[cursor] === ")") {
      return {
        destination: text.slice(destinationStart, cursor),
        end: cursor + 1,
        isImage,
        label,
      };
    }

    cursor += getCodePointLength(text, cursor);
  }

  return undefined;
}

function isCustomEmojiMarkdownLink(match: MarkdownLinkMatch): boolean {
  return match.isImage && /^tg:\/\/emoji\?id=\d+$/.test(match.destination);
}

function formatMarkdownCustomEmoji(replacement: EmojiReplacement): string {
  return `![${replacement.fallback}](tg://emoji?id=${replacement.id})`;
}

function replaceMarkdownEmoji(text: string, registry: EmojiRegistry): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text.startsWith("```", index)) {
      const end = findMarkdownFenceEnd(text, index);
      result += text.slice(index, end);
      index = end;
      continue;
    }

    if (text[index] === "`") {
      const end = findMarkdownInlineCodeEnd(text, index);
      result += text.slice(index, end);
      index = end;
      continue;
    }

    if (text[index] === "\\" && index + 1 < text.length) {
      result += text.slice(index, index + 2);
      index += 2;
      continue;
    }

    const linkMatch =
      text[index] === "[" || (text[index] === "!" && text[index + 1] === "[")
        ? findMarkdownLinkMatch(text, index)
        : undefined;

    if (linkMatch !== undefined) {
      const replacement = isCustomEmojiMarkdownLink(linkMatch)
        ? findExactEmojiReplacement(linkMatch.label, registry)
        : undefined;

      result += replacement
        ? formatMarkdownCustomEmoji(replacement)
        : text.slice(index, linkMatch.end);
      index = linkMatch.end;
      continue;
    }

    const replacement = findEmojiReplacementAt(text, index, registry);

    if (replacement) {
      result += formatMarkdownCustomEmoji(replacement);
      index += replacement.emoji.length;
      continue;
    }

    const length = getCodePointLength(text, index);
    result += text.slice(index, index + length);
    index += length;
  }

  return result;
}

function withFormattedEmoji(
  payload: ApiPayload,
  textField: "text" | "caption",
  entityField: "entities" | "caption_entities",
  registry: EmojiRegistry,
): ApiPayload {
  const text = payload[textField];

  if (typeof text !== "string") {
    return payload;
  }

  if (payload.parse_mode === "HTML") {
    const replaced = replaceHtmlEmoji(text, registry);
    return replaced === text ? payload : { ...payload, [textField]: replaced };
  }

  if (payload.parse_mode === "MarkdownV2") {
    const replaced = replaceMarkdownEmoji(text, registry);
    return replaced === text ? payload : { ...payload, [textField]: replaced };
  }

  return withCustomEmojiEntities(payload, textField, entityField, registry);
}

function withRichMessageEmoji(
  payload: ApiPayload,
  registry: EmojiRegistry,
): ApiPayload {
  const richMessage = payload.rich_message;

  if (!isRecord(richMessage)) {
    return payload;
  }

  let nextRichMessage = richMessage;

  if (typeof richMessage.html === "string") {
    const html = replaceHtmlEmoji(richMessage.html, registry);

    if (html !== richMessage.html) {
      nextRichMessage = { ...nextRichMessage, html };
    }
  }

  if (typeof richMessage.markdown === "string") {
    const markdown = replaceMarkdownEmoji(richMessage.markdown, registry);

    if (markdown !== richMessage.markdown) {
      nextRichMessage = { ...nextRichMessage, markdown };
    }
  }

  return nextRichMessage === richMessage
    ? payload
    : { ...payload, rich_message: nextRichMessage };
}

function withVisualEmoji(
  payload: ApiPayload,
  registry: EmojiRegistry,
): ApiPayload {
  let nextPayload = payload;
  nextPayload = withFormattedEmoji(nextPayload, "text", "entities", registry);
  nextPayload = withFormattedEmoji(
    nextPayload,
    "caption",
    "caption_entities",
    registry,
  );
  nextPayload = withRichMessageEmoji(nextPayload, registry);
  return nextPayload;
}

export function createEmojiPackTransformer(
  database: Database,
  api: StickerSetReader,
): Transformer {
  return async (prev, method, payload, signal) => {
    if (!isRecord(payload) || !hasReplacementCandidates(payload)) {
      return await prev(method, payload, signal);
    }

    try {
      const registry = await getEmojiRegistry(database, api);

      if (registry.replacements.length === 0) {
        return await prev(method, payload, signal);
      }

      const nextPayload = withVisualEmoji(payload, registry) as typeof payload;
      return await prev(method, nextPayload, signal);
    } catch (error) {
      logError("Failed to apply emoji pack replacements", { method, error });
      return await prev(method, payload, signal);
    }
  };
}

emojiPacksComposer.command("packs", async (ctx) => {
  await ctx.reply(formatEmojiPacksList(await listEmojiPacks(ctx.database)));
});

emojiPacksComposer.command("pack_add", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("Only the admin can change emoji packs.");
    return;
  }

  const name = parsePackName(typeof ctx.match === "string" ? ctx.match : "");

  if (!name) {
    await ctx.reply(getPackCommandUsage("pack_add"));
    return;
  }

  let emojiCount: number;
  try {
    emojiCount = await validateEmojiPack(ctx.api, name);
  } catch (error) {
    logError("Failed to validate emoji pack", { name, error });
    await ctx.reply(`Could not add ${name}: custom emoji pack not found.`);
    return;
  }

  const result = await createEmojiPack(ctx.database, name);

  if (result === "exists") {
    await ctx.reply(`${name} is already active.`);
    return;
  }

  invalidateEmojiRegistry();
  await ctx.reply(`Added ${name} (${emojiCount} emoji).`);
});

emojiPacksComposer.command("pack_remove", async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.reply("Only the admin can change emoji packs.");
    return;
  }

  const name = parsePackName(typeof ctx.match === "string" ? ctx.match : "");

  if (!name) {
    await ctx.reply(getPackCommandUsage("pack_remove"));
    return;
  }

  if (!(await removeEmojiPack(ctx.database, name))) {
    await ctx.reply(`${name} is not active.`);
    return;
  }

  invalidateEmojiRegistry();
  await ctx.reply(`Removed ${name}.`);
});
