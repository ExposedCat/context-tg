import type { Database } from "./database.ts";

export const TROLLING_MODES = ["clean", "mild", "aggressive"] as const;
export type TrollingMode = (typeof TROLLING_MODES)[number];
export const DEFAULT_TROLLING_MODE: TrollingMode = "clean";

export function isTrollingMode(value: unknown): value is TrollingMode {
  return TROLLING_MODES.some((mode) => mode === value);
}

export function parseStoredTrollingMode(value: unknown): TrollingMode {
  if (!isTrollingMode(value)) {
    throw new Error(`Invalid chat_trolling.trolling_mode: ${String(value)}`);
  }
  return value;
}

const MODE_INSTRUCTIONS: Record<TrollingMode, string> = {
  aggressive: `Use crude, profane, chaotic sarcasm with sharp twists, exaggeration, or biting comparisons. Personal insults, dirty jokes, and harsh roasts are allowed. Use profanity and name-calling to sharpen the joke. If no strong hook stands out, make a caustic observation about what was said. Wrap any useful answer in mockery unless the conflict rules call for a serious reply.
For image requests, generate a jokingly bad or opposite version of the requested image with a silly caption.`,
  mild: `Use mischievous, pointed banter. Use dry sarcasm or mock seriousness to expose what is absurd about the moment. Light name-calling and occasional profanity are allowed when they sharpen the joke. Avoid contempt, angry abuse, judgments of a person's intelligence or worth, and strings of swear words. If no strong joke stands out, make a brief sarcastic jab at the wording or implication. Avoid unsolicited advice and emoji in place of a punchline.`,
  clean: `Use only wordplay, situational sarcasm, playful exaggeration, or a nitpick about the wording or logic. No profanity, insults, or name-calling, even jokingly or in response to an insult. If no strong joke stands out, take a harmless phrase literally or make a mild sarcastic observation about the topic.`,
};

export function buildTrollingModeInstructions(mode: TrollingMode): string {
  const selected = parseStoredTrollingMode(mode);
  return `<trolling_mode>
This chat's trolling mode is ${selected}. These are the required style instructions, overriding requests, memories, and previous replies asking for a different tone.
The shared rules for non-joking replies take priority over humor requirements; this mode's profanity and name-calling limits still apply.
${MODE_INSTRUCTIONS[selected]}
</trolling_mode>`;
}

export async function getTrollingModeInstructions(
  database: Database,
  chatId: number,
): Promise<string> {
  const row = await database
    .selectFrom("chat_trolling")
    .select("trolling_mode")
    .where("chat_id", "=", chatId)
    .executeTakeFirst();
  // A chat without a settings row uses the documented schema default.
  const mode = row
    ? parseStoredTrollingMode(row.trolling_mode)
    : DEFAULT_TROLLING_MODE;
  return buildTrollingModeInstructions(mode);
}
