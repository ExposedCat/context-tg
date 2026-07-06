import { APP_ENV } from "../env.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import type { FunctionToolRunner } from "./types.ts";
import { getJsonError, getString } from "./utils.ts";

type ImageGenerationData = {
  b64_json?: unknown;
  url?: unknown;
  revised_prompt?: unknown;
};

type ImageGenerationResponse = {
  data?: unknown;
  error?: {
    message?: unknown;
  };
};

export const toolDefinition = {
  type: "function",
  name: "generate_image",
  description:
    "Generate one image from a text prompt. Never use proactively. Use this only when the user explicitly asks to create, draw, render, or visualize an image. After using it, respond with a short caption or note that the image is attached.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "A complete image generation prompt describing the subject, style, composition, and important visual details.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export const nsfwToolDefinition = {
  ...toolDefinition,
  name: "generate_image_nsfw",
  description:
    "Generate one image from a text prompt with the alternate NSFW image model. Never use proactively. Use this only when the user explicitly asks for the alternate NSFW model. This uses less strict safety filters, but still requires careful prompting around filters. After using it, respond with a short caption or note that the image is attached.",
} as const;

function getImageGenerationUrl(): string {
  if (!APP_ENV.LLM_IMAGE_BASE_URL) {
    throw new Error("LLM_IMAGE_BASE_URL is not set.");
  }

  const baseUrl = APP_ENV.LLM_IMAGE_BASE_URL.replace(/\/+$/, "");
  return `${baseUrl}/images/generations`;
}

function getAzureAltImageGenerationUrl(): string {
  if (!APP_ENV.AZURE_ALT_IMAGE_BASE_URL) {
    throw new Error("AZURE_ALT_IMAGE_BASE_URL is not set.");
  }

  return APP_ENV.AZURE_ALT_IMAGE_BASE_URL;
}

export function isConfigured(): boolean {
  return Boolean(
    APP_ENV.LLM_IMAGE_BASE_URL &&
      APP_ENV.LLM_IMAGE_MODEL &&
      APP_ENV.LLM_IMAGE_API_KEY,
  );
}

export function isNsfwConfigured(): boolean {
  return Boolean(
    APP_ENV.AZURE_ALT_IMAGE_BASE_URL &&
      APP_ENV.AZURE_ALT_IMAGE_KEY &&
      LLM_DEPLOYMENTS.image.deploymentName,
  );
}

function getConfiguredNsfwDeploymentName(): string {
  const deploymentName = LLM_DEPLOYMENTS.image.deploymentName;

  if (deploymentName) {
    return deploymentName;
  }

  throw new Error(
    "Image model is not configured. Admin must run /model image DEPLOYMENT_NAME.",
  );
}

function getFirstImageData(response: ImageGenerationResponse) {
  if (!Array.isArray(response.data)) {
    return undefined;
  }

  return response.data.find(
    (item): item is ImageGenerationData =>
      typeof item === "object" && item !== null,
  );
}

async function createImage(prompt: string, signal?: AbortSignal) {
  const response = await fetch(getImageGenerationUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${APP_ENV.LLM_IMAGE_API_KEY ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: APP_ENV.LLM_IMAGE_MODEL ?? "",
      prompt,
      n: 1,
    }),
    signal,
  });
  const text = await response.text();
  let payload: ImageGenerationResponse;

  try {
    payload = JSON.parse(text) as ImageGenerationResponse;
  } catch {
    throw new Error(
      `Image API returned non-JSON response: ${text.slice(0, 200)}`,
    );
  }

  if (!response.ok) {
    const message = getString(payload.error?.message) || text.slice(0, 200);
    throw new Error(`Image API returned HTTP ${response.status}: ${message}`);
  }

  const image = getFirstImageData(payload);
  const b64Json = getString(image?.b64_json);
  const url = getString(image?.url);

  if (!image || (!b64Json && !url)) {
    throw new Error("Image API response did not include an image.");
  }

  const revisedPrompt = getString(image.revised_prompt) || undefined;

  return {
    prompt,
    revisedPrompt,
    url: url || undefined,
    dataUrl: b64Json ? `data:image/png;base64,${b64Json}` : undefined,
    mimeType: b64Json ? "image/png" : undefined,
  };
}

async function createNsfwImage(prompt: string, signal?: AbortSignal) {
  const response = await fetch(getAzureAltImageGenerationUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${APP_ENV.AZURE_ALT_IMAGE_KEY ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: getConfiguredNsfwDeploymentName(),
      prompt,
      width: 1024,
      height: 1024,
      n: 1,
    }),
    signal,
  });
  const text = await response.text();
  let payload: ImageGenerationResponse;

  try {
    payload = JSON.parse(text) as ImageGenerationResponse;
  } catch {
    throw new Error(
      `Azure alternate image API returned non-JSON response: ${text.slice(
        0,
        200,
      )}`,
    );
  }

  if (!response.ok) {
    const message = getString(payload.error?.message) || text.slice(0, 200);
    throw new Error(
      `Azure alternate image API returned HTTP ${response.status}: ${message}`,
    );
  }

  const image = getFirstImageData(payload);
  const b64Json = getString(image?.b64_json);
  const url = getString(image?.url);

  if (!image || (!b64Json && !url)) {
    throw new Error("Image API response did not include an image.");
  }

  const revisedPrompt = getString(image.revised_prompt) || undefined;

  return {
    prompt,
    revisedPrompt,
    url: url || undefined,
    dataUrl: b64Json ? `data:image/png;base64,${b64Json}` : undefined,
    mimeType: b64Json ? "image/png" : undefined,
  };
}

export const execute: FunctionToolRunner = async (args, _context, options) => {
  const prompt = getString(args?.prompt);

  if (!prompt) {
    return getJsonError("Missing image prompt.");
  }

  if (!isConfigured()) {
    return getJsonError("Image generation is not configured.");
  }

  const image = await createImage(prompt, options?.signal);

  return {
    output: JSON.stringify({
      generated_image: {
        attached: true,
        prompt: image.prompt,
        revised_prompt: image.revisedPrompt,
        url: image.url,
      },
    }),
    image,
  };
};

export const executeNsfw: FunctionToolRunner = async (
  args,
  _context,
  options,
) => {
  const prompt = getString(args?.prompt);

  if (!prompt) {
    return getJsonError("Missing image prompt.");
  }

  if (!isNsfwConfigured()) {
    return getJsonError("Image generation is not configured.");
  }

  const image = await createNsfwImage(prompt, options?.signal);

  return {
    output: JSON.stringify({
      generated_image: {
        attached: true,
        prompt: image.prompt,
        revised_prompt: image.revisedPrompt,
        url: image.url,
      },
    }),
    image,
  };
};
