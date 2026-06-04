import { Composer } from "grammy";
import type { Context } from "../bot.ts";
import {
  getLlmModelNames,
  isLlmModelTier,
  setLlmModelName,
} from "./llm-models.ts";

export const stateComposer = new Composer<Context>();

function getModelCommandUsage(): string {
  return [
    "Usage: /model small NAME",
    "Usage: /model big NAME",
    "",
    `Current: small=${getLlmModelNames().small}, big=${getLlmModelNames().big}`,
  ].join("\n");
}

stateComposer.chatType("private").command("start", async (ctx) => {
  await ctx.reply(ctx.t("start", { name: ctx.from.first_name }));
});

stateComposer.chatType("private").command("stop", async (ctx) => {
  await ctx.reply(ctx.t("stop", { name: ctx.from.first_name }));
});

stateComposer.command("model", async (ctx) => {
  const args = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!args) {
    await ctx.reply(getModelCommandUsage());
    return;
  }

  const [tier, ...modelNameParts] = args.split(/\s+/);
  const modelName = modelNameParts.join(" ").trim();

  if (!isLlmModelTier(tier) || !modelName) {
    await ctx.reply(getModelCommandUsage());
    return;
  }

  const updatedModelName = setLlmModelName(tier, modelName);

  await ctx.reply(`Updated ${tier} model to ${updatedModelName}`);
});
