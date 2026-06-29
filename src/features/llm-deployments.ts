import { APP_ENV } from "./env.ts";

export type LlmDeploymentId = "small" | "big" | "openminded";

export const LLM_DEPLOYMENTS = {
  small: {
    id: "small",
    deploymentName: APP_ENV.LLM_MODEL_SMALL,
    withReasoning: true,
  },
  big: {
    id: "big",
    deploymentName: APP_ENV.LLM_MODEL,
    withReasoning: true,
  },
  openMinded: {
    id: "openminded",
    deploymentName: APP_ENV.LLM_MODEL_OPENMINDED,
    withReasoning: false,
  },
} as const;

export type LlmDeployment =
  (typeof LLM_DEPLOYMENTS)[keyof typeof LLM_DEPLOYMENTS];

export const LLM_DEPLOYMENT_OPTIONS = [
  LLM_DEPLOYMENTS.small,
  LLM_DEPLOYMENTS.big,
  LLM_DEPLOYMENTS.openMinded,
] as const satisfies readonly LlmDeployment[];

export function isLlmDeploymentId(value: string): value is LlmDeploymentId {
  return LLM_DEPLOYMENT_OPTIONS.some((deployment) => deployment.id === value);
}
