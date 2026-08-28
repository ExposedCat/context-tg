import { APP_ENV } from "../env.ts";
import { saveImage } from "../images.ts";
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
    "Generate and save one image from a text prompt. Never use proactively. Use this only when the user explicitly asks to create, draw, render, or visualize an image. The result contains a ready-to-use rich Markdown image reference. Include that reference in your response wherever you want the image to appear.",
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

export function isAlternateConfigured(): boolean {
  return Boolean(
    APP_ENV.AZURE_ALT_IMAGE_BASE_URL &&
      APP_ENV.AZURE_ALT_IMAGE_KEY &&
      LLM_DEPLOYMENTS.image.deploymentName,
  );
}

function getConfiguredAlternateDeploymentName(): string {
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

async function createAlternateImage(prompt: string, signal?: AbortSignal) {
  const response = await fetch(getAzureAltImageGenerationUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${APP_ENV.AZURE_ALT_IMAGE_KEY ?? ""}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: getConfiguredAlternateDeploymentName(),
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

  if (!options?.database) {
    return getJsonError(
      "Cannot save generated image: database is unavailable.",
    );
  }

  if (!options.api) {
    return getJsonError(
      "Cannot save generated image: Telegram API is unavailable.",
    );
  }

  let defaultError: unknown;
  let image: Awaited<ReturnType<typeof createImage>>;

  try {
    if (!isConfigured()) {
      throw new Error("Default image generation is not configured.");
    }

    image = await createImage(prompt, options.signal);
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    defaultError = error;

    try {
      if (!isAlternateConfigured()) {
        throw new Error("Alternate image generation is not configured.");
      }

      image = await createAlternateImage(prompt, options.signal);
    } catch (alternateError) {
      if (options.signal?.aborted) {
        throw alternateError;
      }

      throw new Error(
        [
          `Default image model failed: ${getErrorMessage(defaultError)}`,
          `Alternate image model failed: ${getErrorMessage(alternateError)}`,
        ].join("\n"),
      );
    }
  }

  const storedImage = await saveImage(options.database, options.api, image);
  return getImageToolResult(image, storedImage.id);
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getImageToolResult(
  image: Awaited<ReturnType<typeof createImage>>,
  imageId: string,
): ReturnType<FunctionToolRunner> {
  const markdown = `![](tg://photo?id=${imageId})`;

  return {
    output: JSON.stringify({
      generated_image: {
        id: imageId,
        markdown,
        prompt: image.prompt,
        revised_prompt: image.revisedPrompt,
      },
    }),
    generatedImageId: imageId,
  };
}
