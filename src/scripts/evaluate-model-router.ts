// Opt-in live evaluation; calls only the model endpoint, never Telegram or SQLite.
import { requestModelRoute } from "../features/llm.ts";
import { setLlmDeploymentName } from "../features/llm-deployments.ts";
import { formatPromptMessageXml } from "../features/llm-prompt.ts";

type EvaluationCase = {
  name: string;
  current: string;
  earlier?: string[];
  reply?: { sender: string; text: string };
  forwarded?: boolean;
  respond: boolean;
};

const cases: EvaluationCase[] = [
  {
    name: "forwarded factual claim",
    current:
      "Sega помогла NVIDIA избежать банкротства, выделив 5 миллионов долларов на разработку следующего чипа.",
    forwarded: true,
    respond: true,
  },
  {
    name: "forwarded advertisement",
    current: "ПОДПИСЫВАЙСЯ НА КАНАЛ! Промокод SALE, скидка 20% только сегодня!",
    forwarded: true,
    respond: false,
  },
  { name: "empty forward", current: "", forwarded: true, respond: false },
  {
    name: "forwarded meme",
    current: "Когда понедельник пришёл, а ты ещё котик: мяу мяу 😂😂😂",
    forwarded: true,
    respond: false,
  },
  {
    name: "discussion about bot",
    current: "как думаете лейло умный или нет",
    respond: false,
  },
  {
    name: "name-prefix speculation",
    current: "лейло бы точно смог ответить",
    respond: false,
  },
  {
    name: "indirect speculation",
    current: "думаю лейло бы точно смог ответить",
    earlier: [
      "как думаете лейло умный или нет",
      "лейло бы точно смог ответить",
    ],
    respond: false,
  },
  {
    name: "human follow-up",
    current: "я не шучу",
    earlier: [
      "братаны лейло это хуйня не юзайте его",
      "I see things which you do not",
    ],
    reply: { sender: "Artem", text: "I see things which you do not" },
    respond: false,
  },
  {
    name: "unaddressed factual question",
    current: "братаны кто знает это правда что сега тип спасла нвидию бешено",
    respond: false,
  },
  {
    name: "older request then test",
    current: "тест",
    earlier: ["лейло, объясни квантовую физику"],
    respond: false,
  },
  {
    name: "older request then thanks",
    current: "спасибо",
    earlier: ["лейло, объясни квантовую физику"],
    respond: false,
  },
  {
    name: "older request then speculation",
    current: "лейло такое наверняка знает",
    earlier: ["лейло, объясни квантовую физику"],
    respond: false,
  },
  {
    name: "quoted request",
    current: "Артём написал «лейло, проверь это», а потом ушёл.",
    respond: false,
  },
  {
    name: "group question about named bot",
    current:
      "Ребят, кто-нибудь проверял, насколько хорошо @test_bot переводит?",
    respond: false,
  },
  { name: "greeting", current: "привет, лейло", respond: false },
  { name: "bare name", current: "лейло", respond: false },
  {
    name: "hostile dismissal",
    current: "лейло ты тупой, отстань",
    respond: false,
  },
  { name: "empty caption", current: "", respond: false },
  {
    name: "news without request",
    current: "NVIDIA объявила о покупке компании, лейло теперь станет умнее",
    respond: false,
  },
  {
    name: "direct research request",
    current: "лейло, проверь, правда ли Sega спасла NVIDIA",
    respond: true,
  },
  {
    name: "suffix address",
    current: "Переведи hello на русский, лейло",
    respond: true,
  },
  {
    name: "username request",
    current: "@test_bot, сравни эти два подхода",
    respond: true,
  },
  {
    name: "latest request overrides older topic",
    current: "лейло, сколько будет 2+2?",
    earlier: ["Какая погода в Токио?", "Объясни историю NVIDIA"],
    respond: true,
  },
  {
    name: "question in direct bot reply",
    current: "лейло, можешь объяснить второй пункт?",
    reply: { sender: "Laylo", text: "Первый пункт: A. Второй пункт: B." },
    respond: true,
  },
  {
    name: "explicit private request",
    current: "лейло, напиши короткую функцию сортировки на Python",
    respond: true,
  },
  {
    name: "private acknowledgement",
    current: "ага, ясно",
    respond: false,
  },
];

const [deployment, repetitionsText = "2"] = Bun.argv.slice(2);
const repetitions = Number(repetitionsText);
if (
  !deployment ||
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  repetitions > 10
) {
  throw new Error(
    "Usage: bun src/scripts/evaluate-model-router.ts DEPLOYMENT [REPETITIONS:1-10]",
  );
}
setLlmDeploymentName("router", deployment);

let falsePositives = 0;
let missedRequests = 0;
let errors = 0;
const checks = cases.flatMap((scenario) =>
  Array.from({ length: repetitions }, (_, repetition) => async () => {
    const earlier = (scenario.earlier ?? []).map((text, index) =>
      formatPromptMessageXml({ id: index + 1, sender: "Participant" }, text),
    );
    const current = formatPromptMessageXml(
      { id: 100, sender: "Artem" },
      scenario.current,
      {
        reply: scenario.reply
          ? {
              attributes: { id: 99, sender: scenario.reply.sender },
              excerpt: scenario.reply.text,
            }
          : undefined,
      },
    );
    try {
      const verdict = await requestModelRoute(
        [...earlier, current],
        ["laylo", "лейло", "@test_bot"],
        { forwarded: scenario.forwarded },
      );
      const passed = verdict.respond === scenario.respond;
      if (!passed) {
        if (verdict.respond) falsePositives++;
        else missedRequests++;
      }
      console.log(
        JSON.stringify({
          case: scenario.name,
          repetition: repetition + 1,
          passed,
          expected: scenario.respond,
          verdict,
        }),
      );
    } catch (error) {
      errors++;
      console.log(
        JSON.stringify({
          case: scenario.name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }),
);
for (let index = 0; index < checks.length; index += 4) {
  await Promise.all(checks.slice(index, index + 4).map((check) => check()));
}
console.log(
  JSON.stringify({
    deployment,
    checks: checks.length,
    falsePositives,
    missedRequests,
    errors,
  }),
);
if (falsePositives || missedRequests || errors) process.exitCode = 1;
