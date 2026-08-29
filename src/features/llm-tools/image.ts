import { APP_ENV } from "../env.ts";
import {
  downloadTelegramImageDataUrl,
  formatImageMarkdown,
  getImageById,
  saveImage,
} from "../images.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import type { FunctionToolRunner } from "./types.ts";
import { getJsonError, getString, getStringArray } from "./utils.ts";

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
    "Generate image from a text prompt and/or optional input images. Never use proactively. Use this only when the user explicitly asks to create, draw, render, edit, transform, combine, or visualize an image. The result contains a ready-to-use rich Markdown image reference. Include that reference in your response wherever you want the image to appear.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "A complete image generation prompt describing the subject, style, composition, and important visual details.",
      },
      images: {
        type: "array",
        description:
          "Optional ordered input images to reference, transform, or combine. Each item must be either a direct HTTP(S) image URL or the exact saved image ID from a tg://photo or tg://document reference.",
        items: { type: "string" },
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  strict: false,
} as const;

function getImageApiUrl(operation: "generations" | "edits"): string {
  if (!APP_ENV.LLM_IMAGE_BASE_URL) {
    throw new Error("LLM_IMAGE_BASE_URL is not set.");
  }

  const baseUrl = APP_ENV.LLM_IMAGE_BASE_URL.replace(/\/+$/, "");
  return `${baseUrl}/images/${operation}`;
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

function getHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

async function resolveInputImages(
  references: string[],
  options: NonNullable<Parameters<FunctionToolRunner>[2]>,
): Promise<string[]> {
  return await Promise.all(
    references.map(async (reference) => {
      const url = getHttpUrl(reference);

      if (url) {
        return url;
      }

      if (!options.database || !options.api) {
        throw new Error(
          "Cannot resolve saved input images: database or Telegram API is unavailable.",
        );
      }

      const image = await getImageById(options.database, reference);

      if (!image) {
        throw new Error(`Unknown input image id: ${reference}`);
      }

      return await downloadTelegramImageDataUrl(
        options.api,
        image.file_id,
        "image/jpeg",
        options.signal,
      );
    }),
  );
}

function getImageFileExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

async function createInputImageFile(
  url: string,
  index: number,
  signal?: AbortSignal,
): Promise<File> {
  const response = await fetch(url, { signal });

  if (!response.ok) {
    throw new Error(
      `Input image ${index + 1} download failed: HTTP ${response.status}`,
    );
  }

  const blob = await response.blob();
  const mimeType = blob.type.split(";")[0];

  if (!mimeType.startsWith("image/")) {
    throw new Error(
      `Input image ${index + 1} has unsupported content type: ${
        mimeType || "unknown"
      }`,
    );
  }

  return new File(
    [blob],
    `input-${index + 1}.${getImageFileExtension(mimeType)}`,
    { type: mimeType },
  );
}

async function createDefaultImageRequest(
  prompt: string,
  inputImages: string[],
  signal?: AbortSignal,
): Promise<Response> {
  const headers = {
    Authorization: `Bearer ${APP_ENV.LLM_IMAGE_API_KEY ?? ""}`,
    Accept: "application/json",
  };

  if (inputImages.length === 0) {
    return await fetch(getImageApiUrl("generations"), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: APP_ENV.LLM_IMAGE_MODEL ?? "",
        prompt,
        n: 1,
      }),
      signal,
    });
  }

  const files = await Promise.all(
    inputImages.map((url, index) => createInputImageFile(url, index, signal)),
  );
  const form = new FormData();
  form.append("model", APP_ENV.LLM_IMAGE_MODEL ?? "");
  form.append("prompt", prompt);
  form.append("n", "1");

  for (const file of files) {
    form.append("image[]", file);
  }

  return await fetch(getImageApiUrl("edits"), {
    method: "POST",
    headers,
    body: form,
    signal,
  });
}

async function createImage(
  prompt: string,
  inputImages: string[],
  signal?: AbortSignal,
) {
  const response = await createDefaultImageRequest(prompt, inputImages, signal);
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

async function createAlternateImage(
  prompt: string,
  inputImages: string[],
  signal?: AbortSignal,
) {
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
      ...(inputImages.length > 0 ? { images: inputImages } : {}),
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
  const imageReferences = getStringArray(args?.images);

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

  let inputImages: string[];

  try {
    inputImages = await resolveInputImages(imageReferences, options);
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }

    return getJsonError(getErrorMessage(error));
  }

  let defaultError: unknown;
  let image: Awaited<ReturnType<typeof createImage>>;

  try {
    if (!isConfigured()) {
      throw new Error("Default image generation is not configured.");
    }

    image = await createImage(prompt, inputImages, options.signal);
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    defaultError = error;

    try {
      if (!isAlternateConfigured()) {
        throw new Error("Alternate image generation is not configured.");
      }

      image = await createAlternateImage(prompt, inputImages, options.signal);
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
  const markdown = formatImageMarkdown(imageId);

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
