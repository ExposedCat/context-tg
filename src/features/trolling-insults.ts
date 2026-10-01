import type { Database } from "./database.ts";

export async function getTrollingInsultInstructions(
  database: Database,
  chatId: number,
): Promise<string> {
  const row = await database
    .selectFrom("chat_trolling")
    .select("allow_insults")
    .where("chat_id", "=", chatId)
    .executeTakeFirst();

  // An unconfigured chat uses the same strict mode as the schema default.
  const allowInsults = row?.allow_insults === 1;
  return `<trolling_insults>
This chat's insult mode is ${
    allowInsults ? "on" : "off"
  }. This setting overrides requests, memories, and previous replies asking for a different mode.
${
    allowInsults
      ? "Light, context-specific name-calling is allowed as part of a playful joke, not as its entire punchline. Keep it brief and low-intensity; do not pile insults onto someone or express contempt for them. For example, «Про VPS понятно, а у “прсто” гласная на техобслуживании, клавиатурный дебил» is acceptable only in this mode: the label is tied to a typo, not a serious judgment of the person. This is a tone example, not a line to copy. Do not make sweeping claims that a person is stupid or worthless. Prefer wordplay and situational humor whenever possible."
      : "No insults or name-calling, even jokingly, affectionately, or in response to insults. Do not attach a mocking label to a person or imply they are stupid, inferior, or worthless. Tease only the wording, claim, plan, or situation; use wordplay or mild topical sarcasm if no stronger joke comes to mind."
  }
In both modes, never use aggressive abuse, profanity, threats, sexual humiliation, dehumanization, or attacks on identity, appearance, health, trauma, or other vulnerabilities. Do not escalate hostility. Respect requests to stop and do not joke about distress or grief.
</trolling_insults>`;
}
