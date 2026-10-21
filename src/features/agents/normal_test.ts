import { test } from "bun:test";
import { strictEqual } from "node:assert";

test("NAMES configures normal triggers and identity at startup", async () => {
  const customNames =
    "laylo,patrick,патрик,лейло,context,контекст,grok,грок,claude,клод,gpt,гпт,@grok,@грок";
  const indexUrl = new URL("./index.ts", import.meta.url).href;
  for (const [configured, expected] of [
    [undefined, ["laylo", "лейло"]],
    [" ,  , ", ["laylo", "лейло"]],
    [" patrick, @grok, @грок ", ["patrick", "@grok", "@грок"]],
    [`  ${customNames}, , `, customNames.split(",")],
  ] as const) {
    // Isolate startup configuration from modules already imported by other tests.
    const script = `
      import { deepStrictEqual, ok, strictEqual } from "node:assert";
      import { normalAgent, guestAgent, tofuAgent, trollAgent, resolveMessageAgentTrigger, stripMessageAgentName } from ${JSON.stringify(indexUrl)};
      const expected = ${JSON.stringify(expected)};
      deepStrictEqual(normalAgent.name, expected);
      for (const name of expected) {
        const text = name.toLocaleUpperCase() + " hello";
        const trigger = resolveMessageAgentTrigger(text, "test_bot");
        strictEqual(trigger?.agent, normalAgent);
        strictEqual(trigger?.name, name);
        strictEqual(stripMessageAgentName(text, "test_bot"), "hello");
        ok(normalAgent.buildInstructions(1, trigger.name).includes("named " + JSON.stringify(name) + " with a goal"));
      }
      strictEqual(resolveMessageAgentTrigger("@test_bot hello", "test_bot")?.name, expected[0]);
      deepStrictEqual(guestAgent.name, ["guest laylo"]);
      deepStrictEqual(tofuAgent.name, ["tofu laylo", "тофу лейло"]);
      strictEqual(trollAgent.name[0], "troll laylo");
    `;
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", "-e", script],
      cwd: new URL("../../../", import.meta.url).pathname,
      env: configured === undefined ? {} : { NAMES: configured },
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    strictEqual(code, 0, stderr);
  }
});
