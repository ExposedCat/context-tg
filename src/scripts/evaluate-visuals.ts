// Opt-in live evaluation of when replies include visuals. Calls only the model
// endpoint with the normal agent's instructions, never Telegram or SQLite.
//
//   bun src/scripts/evaluate-visuals.ts <deployment> [repetitions] [judge] [filter]
//
// Each reply is classified by whether it contains <media-*> graphics. Replies
// with a visual are also graded by a judge model for added clarity and for
// duplicating the surrounding text. Full replies are written to work/visual-eval/<deployment>.
import { constants } from "node:crypto";
import OpenAI from "openai";
import { normalAgent } from "../features/agents/normal.ts";
import { formatPromptMessageXml } from "../features/llm-prompt.ts";

type Expectation = "visual" | "none" | "either";
type EvaluationCase = {
  name: string;
  expect: Expectation;
  current: string;
  earlier?: { sender: string; text: string }[];
  reply?: { sender: string; text: string; forwardedFrom?: string };
};

const FINCEN_POST =
  "Минфин США (FinCEN) расследует киберинцидент: посторонние получили доступ к системе подачи отчётов о подозрительных операциях. Тем временем журналистка Рэмпелл заметила, что IT-директор Минфина Сэм Коркос в те же дни коммитил музыку в свою опенсорс-игру Legatum в духе Civilization, сделанную с помощью Claude. Прав во всем";

const cases: EvaluationCase[] = [
  // Replies that should stay prose.
  {
    name: "news recap of a forwarded post",
    expect: "none",
    current: "лейло о чем речь",
    reply: {
      sender: "Artem",
      text: FINCEN_POST,
      forwardedFrom: "Kekenavts Analytics",
    },
  },
  {
    name: "follow-up question about a news story",
    expect: "none",
    current:
      "лейло а нахуй он публичную репу создал чтоб они всё видели, ему делать нечего?",
    earlier: [{ sender: "Artem", text: FINCEN_POST }],
  },
  {
    name: "fact-check of a forwarded claim",
    expect: "none",
    current:
      "лейло правда? Sega помогла NVIDIA избежать банкротства, выделив 5 миллионов долларов на разработку следующего чипа",
  },
  {
    name: "translation",
    expect: "none",
    current: "лейло как перевести scissors",
  },
  {
    name: "opinion",
    expect: "none",
    current: "лейло тебе нравится новый дизайн телеги или старый был лучше?",
  },
  {
    name: "single fact",
    expect: "none",
    current: "лейло в каком году вышел первый half-life",
  },
  {
    name: "banter",
    expect: "none",
    current: "лейло ты опять тупишь",
  },
  {
    name: "simple two-item contrast",
    expect: "none",
    current: "лейло в чем разница между let и const в js",
  },
  {
    name: "who is right in an argument",
    expect: "none",
    current: "лейло кто прав?",
    earlier: [
      {
        sender: "Dima",
        text: "питон медленный, на нем нельзя писать нормальный бэкенд",
      },
      {
        sender: "Artem",
        text: "инстаграм на джанге написан, так что можно",
      },
    ],
  },
  {
    name: "summarize a discussion",
    expect: "none",
    current: "лейло кратко о чем спорили",
    earlier: [
      {
        sender: "Dima",
        text: "я считаю что удалёнка убивает продуктивность, в офисе быстрее решаются вопросы",
      },
      {
        sender: "Artem",
        text: "а я дома в два раза больше делаю, никто не дёргает",
      },
      {
        sender: "Kate",
        text: "зависит от команды, у нас гибрид и норм",
      },
    ],
  },
  {
    name: "product recommendation with reasons",
    expect: "none",
    current: "лейло какую мышку взять для работы, logitech mx master норм?",
  },
  {
    name: "short how-to",
    expect: "none",
    current: "лейло как в git отменить последний коммит но оставить изменения",
  },
  // Explanations where a visual should appear without being requested.
  {
    name: "protocol message sequence",
    expect: "visual",
    current: "лейло как работает TLS handshake",
  },
  {
    name: "git merge vs rebase history",
    expect: "visual",
    current:
      "лейло объясни чем rebase отличается от merge, что происходит с историей коммитов",
  },
  {
    name: "DNS resolution chain",
    expect: "visual",
    current:
      "лейло что происходит когда я ввожу google.com в браузере, как dns находит адрес",
  },
  {
    name: "numbers to compare",
    expect: "visual",
    current:
      "лейло сравни по цене за гигабайт: iphone 17 256гб за 1199$, pixel 10 128гб за 799$, galaxy s26 256гб за 1099$, xiaomi 17 512гб за 899$",
  },
  {
    name: "system architecture",
    expect: "visual",
    current:
      "лейло объясни как связаны части нашего бота: телеграм присылает апдейты в grammy, сообщения сохраняются в sqlite, эмбеддинги идут в qdrant для поиска, ответы генерирует azure openai, а картинки рендерит chromium",
  },
  {
    name: "change over time",
    expect: "visual",
    current:
      "лейло как в аннуитетной ипотеке меняется доля процентов и тела долга в платеже со временем",
  },
  {
    name: "timeline of releases",
    expect: "visual",
    current:
      "лейло когда выходили все игры half-life и эпизоды, и сколько лет между ними",
  },
  {
    name: "process with a branch",
    expect: "visual",
    current:
      "лейло как работает circuit breaker в микросервисах, какие у него состояния и когда он переключается",
  },
  // Explicit requests.
  {
    name: "explicit diagram request",
    expect: "visual",
    current: "лейло нарисуй схему как работает oauth авторизация",
  },
  {
    name: "explicit no-visual request",
    expect: "none",
    current: "лейло без картинок, текстом: как работает TLS handshake",
  },
  // Borderline: either answer is acceptable, but a visual must add clarity.
  {
    name: "why the sky is blue",
    expect: "either",
    current: "лейло почему небо голубое",
  },
  {
    name: "news with numbers",
    expect: "either",
    current:
      "лейло что там с курсом, доллар был 92 в январе, 96 в марте, 89 в мае и 84 сейчас, это нормально?",
  },
  // Held out: topics the prompt does not name, to catch overfitting.
  ...(
    [
      [
        "none",
        "film recommendation",
        "лейло посоветуй фильм на вечер, что-нибудь типа интерстеллара",
      ],
      [
        "none",
        "error fix",
        "лейло npm install падает с EACCES permission denied, что делать",
      ],
      ["none", "rumor check", "лейло правда что маск купил тикток?"],
      ["none", "plot summary", "лейло перескажи коротко сюжет матрицы"],
      [
        "none",
        "career advice",
        "лейло стоит ли учить rust в 2026 или лучше go",
      ],
      ["none", "definition", "лейло что такое closure в js"],
      [
        "visual",
        "garbage collection",
        "лейло как работает mark and sweep сборщик мусора",
      ],
      ["visual", "consensus election", "лейло как в raft выбирается лидер"],
      [
        "either",
        "market shares",
        "лейло доли рынка браузеров: chrome 65%, safari 18%, edge 5%, firefox 3%, остальные 9% — кто реально конкурирует с хромом?",
      ],
      [
        "visual",
        "computed comparison",
        "лейло что больше жрёт электричества за месяц: чайник 2000вт по 10 минут в день, холодильник 150вт круглосуточно но компрессор работает треть времени, или комп 300вт по 6 часов",
      ],
      [
        "visual",
        "react rerender",
        "лейло что происходит в react когда я меняю стейт в родителе, какие компоненты перерисуются",
      ],
      ["either", "ssh keys", "лейло как работают ssh ключи"],
      [
        "either",
        "inflation",
        "лейло почему при инфляции 8% мои деньги на вкладе под 10% всё равно почти не растут",
      ],
    ] as const
  ).map(([expect, name, current]) => ({
    expect,
    name: `held-out ${name}`,
    current,
  })),
];

const JUDGE_INSTRUCTIONS = `You grade a chat bot's reply that contains visual blocks (<media-*> tags render as images; <media-html-freeform> is a freeform HTML canvas). Judge only the visuals.

adds_clarity: true when a reader understands the answer meaningfully better with the visual than from the reply's prose alone — it shows structure (flow, connections, order, positions on a scale, quantities) that prose conveys poorly. False when the visual is decorative, a list or a couple of text boxes, or could be replaced by a sentence without loss.

duplicates_text: true when the visual mostly restates the same information as the surrounding prose (the same steps, parts, or values), or the prose walks through what the visual shows. A visual that works through a concrete instance of a rule the prose states in one sentence is not duplication.

Be strict: a visual is only justified if removing it would make the answer clearly harder to understand.`;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    adds_clarity: { type: "boolean" },
    duplicates_text: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["adds_clarity", "duplicates_text", "reason"],
  additionalProperties: false,
} as const;

const [deployment, repetitionsText = "1", judgeDeployment, filter] =
  Bun.argv.slice(2);
if (!deployment) {
  console.error(
    "Usage: bun src/scripts/evaluate-visuals.ts <deployment> [repetitions] [judge] [filter]",
  );
  process.exit(2);
}
const repetitions = Number(repetitionsText);
const judge = judgeDeployment || deployment;
const outputDirectory = new URL(
  `../../work/visual-eval/${deployment}/`,
  import.meta.url,
);

// Read only the model credentials so the script runs without the bot's other
// services configured. Bun's TLS 1.3 handshake resets on Azure OpenAI.
const client = new OpenAI({
  apiKey: Bun.env.LLM_API_KEY,
  baseURL: Bun.env.LLM_BASE_URL,
  fetch: (input, init) =>
    fetch(input, {
      ...init,
      tls: { secureOptions: constants.SSL_OP_NO_TLSv1_3 },
    }),
  maxRetries: 2,
  timeout: 300_000,
});
const instructions = normalAgent.buildInstructions(1, "лейло");

function buildInput(scenario: EvaluationCase): string {
  const events = (scenario.earlier ?? []).map((message, index) =>
    formatPromptMessageXml(
      { id: index + 1, sender: message.sender, date: "2026-11-25" },
      message.text,
    ),
  );
  events.push(
    formatPromptMessageXml(
      { id: 100, sender: "Artem", date: "2026-11-25", time: "15:51" },
      scenario.current,
      {
        reply: scenario.reply
          ? {
              attributes: { id: 99, sender: scenario.reply.sender },
              excerpt: scenario.reply.text,
              forwardedFrom: scenario.reply.forwardedFrom
                ? { sender: scenario.reply.forwardedFrom }
                : undefined,
            }
          : undefined,
      },
    ),
  );
  return `<events>\n${events.join("\n")}\n</events>`;
}

async function grade(reply: string) {
  const response = await client.responses.create({
    model: judge,
    instructions: JUDGE_INSTRUCTIONS,
    input: [{ role: "user", content: reply }],
    reasoning: { effort: "medium" },
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "visual_grade",
        schema: JUDGE_SCHEMA,
        strict: true,
      },
    },
  });
  return JSON.parse(response.output_text) as {
    adds_clarity: boolean;
    duplicates_text: boolean;
    reason: string;
  };
}

type Result = {
  name: string;
  expect: Expectation;
  visual: boolean;
  passed: boolean;
  grade?: Awaited<ReturnType<typeof grade>>;
  error?: string;
};

const selected = cases.filter(
  (scenario) => !filter || scenario.name.includes(filter),
);
const results: Result[] = [];
const checks = selected.flatMap((scenario) =>
  Array.from({ length: repetitions }, (_, repetition) => async () => {
    try {
      const response = await client.responses.create({
        model: deployment,
        instructions,
        input: [{ role: "user", content: buildInput(scenario) }],
        reasoning: { effort: "high" },
        store: false,
      });
      const reply = response.output_text;
      const visual = /<media-[a-z]/i.test(reply);
      const result: Result = {
        name: scenario.name,
        expect: scenario.expect,
        visual,
        passed:
          scenario.expect === "either" ||
          visual === (scenario.expect === "visual"),
      };
      if (visual) {
        result.grade = await grade(reply);
        if (!result.grade.adds_clarity || result.grade.duplicates_text)
          result.passed = false;
      }
      results.push(result);
      const file = `${scenario.name.replaceAll(/\W+/g, "-")}-${repetition + 1}.md`;
      await Bun.write(new URL(file, outputDirectory), reply);
      console.log(
        JSON.stringify({
          ...result,
          reason: result.grade?.reason,
          grade: undefined,
          file,
        }),
      );
    } catch (error) {
      results.push({
        name: scenario.name,
        expect: scenario.expect,
        visual: false,
        passed: false,
        error: String(error),
      });
      console.log(
        JSON.stringify({ name: scenario.name, error: String(error) }),
      );
    }
  }),
);

for (let index = 0; index < checks.length; index += 6) {
  await Promise.all(checks.slice(index, index + 6).map((check) => check()));
}

const count = (predicate: (result: Result) => boolean) =>
  results.filter(predicate).length;
console.log(
  JSON.stringify({
    deployment,
    judge,
    checks: results.length,
    passed: count((r) => r.passed),
    pointlessVisuals: count((r) => r.expect === "none" && r.visual),
    missingVisuals: count((r) => r.expect === "visual" && !r.visual),
    weakVisuals: count(
      (r) =>
        r.visual &&
        Boolean(r.grade && (!r.grade.adds_clarity || r.grade.duplicates_text)),
    ),
    errors: count((r) => Boolean(r.error)),
  }),
);
if (results.some((result) => !result.passed)) process.exitCode = 1;
