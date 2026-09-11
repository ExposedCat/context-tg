export type LlmDeploymentId =
  | "small"
  | "big"
  | "openminded"
  | "image"
  | "image_small"
  | "image_big";
export type LlmDeployment = {
  readonly id: LlmDeploymentId;
  deploymentName: string;
  readonly withReasoning: boolean;
};

export const LLM_DEPLOYMENTS = {
  small: {
    id: "small",
    deploymentName: "",
    withReasoning: true,
  },
  big: {
    id: "big",
    deploymentName: "",
    withReasoning: true,
  },
  openMinded: {
    id: "openminded",
    deploymentName: "",
    withReasoning: true,
  },
  imageSmall: {
    id: "image_small",
    deploymentName: "",
    withReasoning: false,
  },
  imageBig: {
    id: "image_big",
    deploymentName: "",
    withReasoning: false,
  },
  image: {
    id: "image",
    deploymentName: "",
    withReasoning: false,
  },
} satisfies Record<string, LlmDeployment>;

export const LLM_DEPLOYMENT_OPTIONS = [
  LLM_DEPLOYMENTS.small,
  LLM_DEPLOYMENTS.big,
  LLM_DEPLOYMENTS.openMinded,
  LLM_DEPLOYMENTS.imageSmall,
  LLM_DEPLOYMENTS.imageBig,
  LLM_DEPLOYMENTS.image,
] as const satisfies readonly LlmDeployment[];

const LLM_DEPLOYMENT_BY_ID = {
  small: LLM_DEPLOYMENTS.small,
  big: LLM_DEPLOYMENTS.big,
  openminded: LLM_DEPLOYMENTS.openMinded,
  image_small: LLM_DEPLOYMENTS.imageSmall,
  image_big: LLM_DEPLOYMENTS.imageBig,
  image: LLM_DEPLOYMENTS.image,
} as const satisfies Record<LlmDeploymentId, LlmDeployment>;

export function isLlmDeploymentId(value: string): value is LlmDeploymentId {
  return LLM_DEPLOYMENT_OPTIONS.some((deployment) => deployment.id === value);
}

export function getLlmDeployment(id: LlmDeploymentId): LlmDeployment {
  return LLM_DEPLOYMENT_BY_ID[id];
}

export function setLlmDeploymentName(
  id: LlmDeploymentId,
  deploymentName: string,
): LlmDeployment {
  const deployment = getLlmDeployment(id);
  deployment.deploymentName = deploymentName;
  return deployment;
}
