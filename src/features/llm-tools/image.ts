import { APP_ENV } from "../env.ts";
import {
  downloadTelegramImageDataUrl,
  formatImageMarkdown,
  getImageById,
  saveImage,
} from "../images.ts";
import { LLM_DEPLOYMENTS } from "../llm-deployments.ts";
import {
  fetchLlmProvider,
  isLlmProviderStatus,
  withLlmFallback,
} from "../llm-provider.ts";
import type { CreditCharge } from "../usage.ts";
import type { FunctionToolRunner, LlmToolUsage } from "./types.ts";
import {
  asRecord,
  getFiniteNumber,
  getJsonError,
  getString,
  getStringArray,
} from "./utils.ts";

type ImageGenerationData = {
  b64_json?: unknown;
  url?: unknown;
  revised_prompt?: unknown;
};

type ImageGenerationResponse = {
  data?: unknown;
  usage?: unknown;
  error?: {
    message?: unknown;
  };
};

function getImageGenerationUsage(
  response: ImageGenerationResponse,
): LlmToolUsage | undefined {
  if (
    typeof response.usage !== "object" ||
    response.usage === null ||
    Array.isArray(response.usage)
  ) {
    return undefined;
  }

  const usage = response.usage as Record<string, unknown>;
  const inputTokens = getFiniteNumber(usage.input_tokens);
  const inputDetails = asRecord(usage.input_tokens_details);
  const cachedTokens = getFiniteNumber(inputDetails?.cached_tokens);
  const outputTokens = getFiniteNumber(usage.output_tokens);

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return {
    input_tokens: inputTokens ?? 0,
    cached_tokens: cachedTokens ?? 0,
    output_tokens: outputTokens ?? 0,
  };
}

export const toolDefinition = {
  type: "function",
  name: "generate_image",
  description:
    "Generate or edit a raster image from a text prompt and optional reference images. Use for explicit requests to create or edit artwork, photos, or illustrations. The result includes a ready-to-use rich Markdown image reference. Copy it where the image should appear in the reply.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "A complete image generation prompt describing the subject, style, composition, and important visual details.",
      },
      size: {
        type: "string",
        enum: ["small", "big"],
        description:
          "Prefer 'small' for most tasks as quick generations or simple edits. Use 'big' for work requested to be high quality, serious, important or complex",
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

type ImageSize = "small" | "big";

function getPrimaryDeploymentName(size: ImageSize): string {
  return (
    size === "big" ? LLM_DEPLOYMENTS.imageBig : LLM_DEPLOYMENTS.imageSmall
  ).deploymentName;
}

export function isConfigured(size: ImageSize = "small"): boolean {
  return Boolean(
    APP_ENV.LLM_BASE_URL &&
      getPrimaryDeploymentName(size) &&
      APP_ENV.LLM_API_KEY,
  );
}

export function isAlternateConfigured(): boolean {
  return Boolean(
    APP_ENV.LLM_BASE_URL &&
      APP_ENV.LLM_API_KEY &&
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

class ImageProviderError extends Error {
  constructor(
    cause: unknown,
    readonly status?: number,
  ) {
    super(getErrorMessage(cause), { cause });
  }
}

async function requestImage(
  model: string,
  prompt: string,
  inputImages: string[],
  signal?: AbortSignal,
  chargeCredits?: CreditCharge,
): Promise<ImageGenerationResponse> {
  const operation = inputImages.length === 0 ? "generations" : "edits";
  const body =
    operation === "generations"
      ? JSON.stringify({ model, prompt, n: 1, moderation: "low" })
      : await createImageEditForm(model, prompt, inputImages, signal);

  return await withLlmFallback(
    async (fallback) => {
      if (fallback) await chargeCredits?.("image_attempt", "generate_image");
      const baseURL = (fallback?.baseURL ?? APP_ENV.LLM_BASE_URL).replace(
        /\/+$/,
        "",
      );
      const headers = {
        Authorization: `Bearer ${fallback?.apiKey ?? APP_ENV.LLM_API_KEY}`,
        Accept: "application/json",
        ...(operation === "generations" && {
          "Content-Type": "application/json",
        }),
      };
      const response = await fetchLlmProvider(
        `${baseURL}/images/${operation}`,
        {
          method: "POST",
          headers,
          body,
          signal,
        },
      ).catch((error) => {
        if (signal?.aborted) throw error;
        throw new ImageProviderError(error);
      });
      try {
        return await readImageResponse(response);
      } catch (error) {
        if (response.ok) throw error;
        throw new ImageProviderError(error, response.status);
      }
    },
    {
      operation: operation === "edits" ? "image_edit" : "image_generation",
      model,
      signal,
      getResultTelemetry: getImageGenerationUsage,
      shouldFallback: (error) =>
        error instanceof ImageProviderError &&
        (error.status === undefined || isLlmProviderStatus(error.status)),
    },
  );
}

async function createImageEditForm(
  model: string,
  prompt: string,
  inputImages: string[],
  signal?: AbortSignal,
): Promise<FormData> {
  const files = await Promise.all(
    inputImages.map((url, index) => createInputImageFile(url, index, signal)),
  );
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("moderation", "low");

  for (const file of files) {
    form.append("image[]", file);
  }

  return form;
}

async function readImageResponse(
  response: Response,
): Promise<ImageGenerationResponse> {
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

  return payload;
}

async function createImage(
  model: string,
  prompt: string,
  inputImages: string[],
  signal?: AbortSignal,
  chargeCredits?: CreditCharge,
) {
  const payload = await requestImage(
    model,
    prompt,
    inputImages,
    signal,
    chargeCredits,
  );
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
    usage: getImageGenerationUsage(payload),
    url: url || undefined,
    dataUrl: b64Json ? `data:image/png;base64,${b64Json}` : undefined,
    mimeType: b64Json ? "image/png" : undefined,
  };
}

export const execute: FunctionToolRunner = async (args, _context, options) => {
  const prompt = getString(args?.prompt);
  const imageReferences = getStringArray(args?.images);
  const size = args?.size ?? "small";
  if (size !== "small" && size !== "big") {
    return getJsonError('Invalid image size: expected "small" or "big".');
  }

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
    if (!isConfigured(size)) {
      throw new Error("Default image generation is not configured.");
    }

    await options.chargeCredits?.("image_attempt", "generate_image");
    image = await createImage(
      getPrimaryDeploymentName(size),
      prompt,
      inputImages,
      options.signal,
      options.chargeCredits,
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    defaultError = error;

    try {
      if (!isAlternateConfigured()) {
        throw new Error("Alternate image generation is not configured.");
      }

      await options.chargeCredits?.("image_attempt", "generate_image");
      image = await createImage(
        getConfiguredAlternateDeploymentName(),
        prompt,
        inputImages,
        options.signal,
        options.chargeCredits,
      );
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

  if (image.usage) {
    options.onUsage?.(image.usage);
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
