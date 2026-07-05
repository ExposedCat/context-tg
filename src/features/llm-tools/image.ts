import type OpenAI from "@openai/openai";
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
    "Generate one image from a text prompt. Never use proactively. Use this only when the user explicitly asks to create, draw, render, or visualize an image. This uses less strict safety filters, but still required trickery and careful prompting to get around filters. After using it, respond with a short caption or note that the image is attached.",
} as const;

function getImageGenerationUrl(): string {
  if (!APP_ENV.LLM_IMAGE_BASE_URL) {
    throw new Error("LLM_IMAGE_BASE_URL is not set.");
  }

  const baseUrl = APP_ENV.LLM_IMAGE_BASE_URL.replace(/\/+$/, "");
  return `${baseUrl}/images/generations`;
}

export function isConfigured(): boolean {
  return Boolean(
    APP_ENV.LLM_IMAGE_BASE_URL &&
      APP_ENV.LLM_IMAGE_MODEL &&
      APP_ENV.LLM_IMAGE_API_KEY,
  );
}

export function isNsfwConfigured(): boolean {
  return Boolean(LLM_DEPLOYMENTS.image.deploymentName);
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

async function createNsfwImage(
  client: OpenAI,
  prompt: string,
  signal?: AbortSignal,
) {
  const response = await client.images.generate(
    {
      model: getConfiguredNsfwDeploymentName(),
      prompt,
      n: 1,
    },
    { signal },
  );
  const image = getFirstImageData(response as ImageGenerationResponse);
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

  if (!options?.client) {
    return getJsonError("LLM client is not available for image generation.");
  }

  const image = await createNsfwImage(options.client, prompt, options?.signal);

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
