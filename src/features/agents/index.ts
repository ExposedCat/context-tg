import { normalAgent } from "./normal.ts";
import { researcherAgent } from "./researcher.ts";
import { traderAgent } from "./trader.ts";
import type { AgentDefinition, AgentId } from "./types.ts";
import { ultimateAgent } from "./ultimate.ts";

export type { AgentDefinition, AgentId } from "./types.ts";
export { normalAgent, researcherAgent, traderAgent, ultimateAgent };

export const AGENTS = [
  normalAgent,
  traderAgent,
  researcherAgent,
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

export function isAgentId(value: string | null | undefined): value is AgentId {
  return AGENTS.some((agent) => agent.id === value);
}
