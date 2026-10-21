import { test } from "bun:test";
import { ok, strictEqual } from "node:assert";
import {
  AGENTS,
  guestAgent,
  normalAgent,
  resolveMessageAgent,
  resolveMessageAgentTrigger,
  stripMessageAgentName,
} from "./index.ts";
import type { AgentDefinition } from "./types.ts";

test("all responding agents reject meaningless token-draining requests", () => {
  for (const agent of AGENTS) {
    ok(
      agent
        .buildInstructions(1)
        .includes(
          "Meaningless long requests aimed at draining tokens must be rejected.",
        ),
      `Missing resource-abuse instruction for ${agent.id}`,
    );
  }
});

test("named triggers inject the matched alias for every non-guest agent", () => {
  for (const agent of AGENTS.filter((agent) => agent.id !== "guest")) {
    for (const name of agent.name) {
      const text = `  ${name.toLocaleUpperCase()}: hello`;
      const trigger = resolveMessageAgentTrigger(text, "test_bot");
      strictEqual(trigger?.agent, agent);
      strictEqual(trigger?.name, name);
      strictEqual(resolveMessageAgent(text, "test_bot"), agent);
      strictEqual(stripMessageAgentName(text, "test_bot"), "hello");
      ok(
        agent
          .buildInstructions(1, trigger?.name)
          .includes(`named ${JSON.stringify(name)} with a goal`),
      );
    }
  }
});

test("username triggers and absent aliases use the first name", () => {
  const trigger = resolveMessageAgentTrigger("@TEST_BOT hello", "test_bot");
  strictEqual(trigger?.agent, normalAgent);
  strictEqual(trigger?.name, normalAgent.name[0]);
  strictEqual(
    resolveMessageAgentTrigger("@other_bot hello", "test_bot"),
    undefined,
  );
  strictEqual(resolveMessageAgentTrigger("hello лейло", "test_bot"), undefined);
  for (const agent of AGENTS) {
    ok(
      agent
        .buildInstructions(1)
        .includes(`named ${JSON.stringify(agent.name[0])} with a goal`),
    );
    ok(
      agent
        .buildInstructions(1, "unrecognized name")
        .includes(`named ${JSON.stringify(agent.name[0])} with a goal`),
    );
  }
});

test("guest identity always uses its first name", () => {
  const agent: AgentDefinition = guestAgent;
  for (const triggerName of ["@test_bot", "лейло", "тролль лейло"]) {
    ok(
      agent
        .buildInstructions(1, triggerName)
        .includes(`named ${JSON.stringify(guestAgent.name[0])} with a goal`),
    );
  }
});
