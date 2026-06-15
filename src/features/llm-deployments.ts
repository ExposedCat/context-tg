import { APP_ENV } from "./env.ts";

export const LLM_DEPLOYMENTS = {
  small: {
    deploymentName: APP_ENV.LLM_MODEL_SMALL,
    withReasoning: false,
  },
  big: {
    deploymentName: APP_ENV.LLM_MODEL,
    withReasoning: true,
  },
  openMinded: {
    deploymentName: APP_ENV.LLM_MODEL_OPENMINDED,
    withReasoning: false,
  },
} as const;

export type LlmDeployment =
  (typeof LLM_DEPLOYMENTS)[keyof typeof LLM_DEPLOYMENTS];
