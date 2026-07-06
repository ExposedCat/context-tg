import { guestAgent } from "./guest.ts";
import { normalAgent } from "./normal.ts";
import { politicianAgent } from "./politician.ts";
import { researcherAgent } from "./researcher.ts";
import { tofuAgent } from "./tofu.ts";
import { traderAgent } from "./trader.ts";
import { trollAgent } from "./troll.ts";
import type { AgentDefinition, AgentId } from "./types.ts";
import { ultimateAgent } from "./ultimate.ts";

export type { AgentDefinition, AgentId, AgentModel } from "./types.ts";
export {
  guestAgent,
  normalAgent,
  politicianAgent,
  researcherAgent,
  tofuAgent,
  trollAgent,
  traderAgent,
  ultimateAgent,
};

export const AGENTS = [
  normalAgent,
  tofuAgent,
  guestAgent,
  traderAgent,
  researcherAgent,
  politicianAgent,
  trollAgent,
  ultimateAgent,
] satisfies AgentDefinition[];

const AGENT_NAME_BOUNDARY = /(?:$|[\s:,.!?()[\]{}"'`-])/;

function startsWithName(text: string, name: string): boolean {
  const normalizedText = text.trimStart().toLocaleLowerCase();
  const normalizedName = name.toLocaleLowerCase();

  return (
    normalizedText.startsWith(normalizedName) &&
    AGENT_NAME_BOUNDARY.test(
      normalizedText.slice(normalizedName.length, normalizedName.length + 1),
    )
  );
}

function startsWithBotMention(text: string, ownUsername: string): boolean {
  return startsWithName(text, `@${ownUsername}`);
}

function stripLeadingName(text: string, name: string): string | undefined {
  if (!startsWithName(text, name)) {
    return undefined;
  }

  const leadingWhitespaceLength = text.length - text.trimStart().length;
  return text
    .slice(leadingWhitespaceLength + name.length)
    .replace(/^[\s:,.!?()[\]{}"'`-]+/, "")
    .trim();
}

export function getAgentById(
  id: string | null | undefined,
): AgentDefinition | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

export function getCallableAgentById(
  id: string | null | undefined,
): AgentDefinition | undefined {
  const agent = getAgentById(id);

  return agent && agent.id !== "ultimate" ? agent : undefined;
}

export function resolveMessageAgent(
  text: string,
  ownUsername: string,
): AgentDefinition | undefined {
  if (startsWithBotMention(text, ownUsername)) {
    return normalAgent;
  }

  return AGENTS.find((agent) =>
    agent.name.some((agentName) => startsWithName(text, agentName)),
  );
}

export function stripMessageAgentName(
  text: string,
  ownUsername: string,
): string {
  const botMentionText = stripLeadingName(text, `@${ownUsername}`);
  if (botMentionText !== undefined) {
    return botMentionText;
  }

  for (const agent of AGENTS) {
    for (const agentName of agent.name) {
      const taskText = stripLeadingName(text, agentName);
      if (taskText !== undefined) {
        return taskText;
      }
    }
  }

  return text.trim();
}

export function isAgentId(value: string | null | undefined): value is AgentId {
  return AGENTS.some((agent) => agent.id === value);
}
