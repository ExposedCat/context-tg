// Opt-in live evaluation; calls only the model endpoint, never Telegram or SQLite.
import { type ModelRoutingGoal, requestModelRoute } from "../features/llm.ts";
import { setLlmDeploymentName } from "../features/llm-deployments.ts";
import { formatPromptMessageXml } from "../features/llm-prompt.ts";

type EvaluationCase = {
  name: string;
  current: string;
  earlier?: string[];
  reply?: { sender: string; text: string };
  forwarded?: boolean;
  respond: boolean;
  model?: "small" | "large";
  goal?: ModelRoutingGoal;
};

const cases: EvaluationCase[] = [
  {
    name: "forwarded factual claim",
    current:
      "Sega помогла NVIDIA избежать банкротства, выделив 5 миллионов долларов на разработку следующего чипа.",
    forwarded: true,
    respond: true,
    goal: "factcheck",
  },
  {
    name: "forwarded question",
    current: "Как перевести слово scissors на русский?",
    forwarded: true,
    respond: true,
    goal: "answer",
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
    goal: "factcheck",
  },
  {
    name: "suffix address",
    current: "Переведи hello на русский, лейло",
    respond: true,
  },
  {
    name: "reported shorthand comparison",
    current: "лейло грабзука или слингшот в коркипере",
    respond: true,
    model: "large",
  },
  {
    name: "shorthand comparison with suffix address",
    current: "грабзука или слингшот в коркипере, лейло",
    respond: true,
    model: "large",
  },
  {
    name: "shorthand comparison with middle address",
    current: "а как думаешь лейло грабзука или слингшот в коркипере",
    respond: true,
    model: "large",
  },
  {
    name: "unfamiliar terms with suffix address",
    current: "зырпушка или флимбомёт для босса в игре, лейло",
    respond: true,
    model: "large",
  },
  {
    name: "English comparison without question mark",
    current: "grabzooka or slingshot in core keeper, laylo",
    respond: true,
    model: "large",
  },
  {
    name: "informal factual question",
    current: "а сколько хп у босса в коркипере, лейло",
    respond: true,
  },
  {
    name: "comparison addressed to another person",
    current: "Даня, грабзука или слингшот? лейло вчера советовал грабзуку",
    respond: false,
  },
  {
    name: "comparison quoted as someone else's request",
    current:
      "Вчера спросил «лейло грабзука или слингшот в коркипере», а потом сам разобрался",
    respond: false,
  },
  {
    name: "answer uncertainty about the bot is not a request",
    current: "лейло наверное не знает что такое грабзука или слингшот",
    respond: false,
  },
  {
    name: "unclear acknowledgement with suffix address",
    current: "ну вот так, лейло",
    respond: false,
  },
  {
    name: "unaddressed comparison",
    current: "грабзука или слингшот в коркипере",
    respond: false,
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
let wrongModels = 0;
let wrongGoals = 0;
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
      const relevancePassed = verdict.respond === scenario.respond;
      const modelPassed =
        scenario.model === undefined || verdict.model === scenario.model;
      const expectedGoal = scenario.goal ?? "answer";
      const goalPassed = !verdict.respond || verdict.goal === expectedGoal;
      const passed = relevancePassed && modelPassed && goalPassed;
      if (!relevancePassed) {
        if (verdict.respond) falsePositives++;
        else missedRequests++;
      }
      if (verdict.respond && !modelPassed) wrongModels++;
      if (verdict.respond && scenario.respond && !goalPassed) wrongGoals++;
      console.log(
        JSON.stringify({
          case: scenario.name,
          repetition: repetition + 1,
          passed,
          expected: scenario.respond,
          expectedModel: scenario.model,
          expectedGoal: scenario.respond ? expectedGoal : undefined,
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
    wrongModels,
    wrongGoals,
    errors,
  }),
);
if (falsePositives || missedRequests || wrongModels || wrongGoals || errors)
  process.exitCode = 1;
