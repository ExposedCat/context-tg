import { constants } from "node:crypto";
import { createDebug } from "@grammyjs/debug";
import OpenAI from "openai";
import { APP_ENV } from "./env.ts";
import {
  emitLlmProviderAttempt,
  type LlmProviderOperation,
  type LlmProviderResultTelemetry,
} from "./telemetry.ts";

type LlmCredentials = { baseURL: string; apiKey: string };
type LlmFallbackOptions<T> = {
  service?: "llm" | "embedder";
  operation: LlmProviderOperation;
  model?: string;
  signal?: AbortSignal;
  shouldFallback?: (error: unknown) => boolean;
  getResultTelemetry?: (response: T) => LlmProviderResultTelemetry | undefined;
};

const logError = createDebug("app:llm:error");

// Preserve the primary failure alongside SDK errors and Responses API results.
const mainProviderFailures = new WeakMap<object, { error: unknown }>();

export function getMainProviderFailure(value: unknown) {
  return typeof value === "object" && value !== null
    ? mainProviderFailures.get(value)
    : undefined;
}

export function carryMainProviderFailure<T extends object>(
  source: unknown,
  target: T,
): T {
  const failure = getMainProviderFailure(source);
  if (failure) mainProviderFailures.set(target, failure);
  return target;
}

export function fetchLlmProvider(
  input: string | URL | Request,
  init?: BunFetchRequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".openai.azure.com")
  ) {
    return fetch(input, init);
  }

  // Bun's TLS 1.3 handshake intermittently resets on Azure OpenAI endpoints.
  return fetch(input, {
    ...init,
    tls: {
      ...init?.tls,
      secureOptions:
        (init?.tls?.secureOptions ?? 0) | constants.SSL_OP_NO_TLSv1_3,
    },
  });
}

export function isLlmProviderStatus(status: number): boolean {
  return [401, 403, 404, 408, 429].includes(status) || status >= 500;
}

export function isLlmProviderError(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIConnectionError ||
    (error instanceof OpenAI.APIError &&
      error.status !== undefined &&
      isLlmProviderStatus(error.status))
  );
}

export function getLlmProviderResponseTelemetry(
  response: OpenAI.Responses.Response,
): LlmProviderResultTelemetry {
  const status = response?.status;
  const code =
    response?.error?.code ??
    response?.incomplete_details?.reason ??
    (status === "completed" ? undefined : status);
  const usage = response?.usage;
  return {
    ...(code && { error_code: getFailureAttributes({ code }).error_code }),
    ...(usage && {
      input_tokens: usage.input_tokens,
      cached_tokens: usage.input_tokens_details?.cached_tokens,
      output_tokens: usage.output_tokens,
    }),
  };
}

function getFailureAttributes(error: unknown) {
  const detail = typeof error === "object" && error !== null ? error : {};
  const status = "status" in detail ? detail.status : undefined;
  const cause = "cause" in detail ? detail.cause : undefined;
  const code =
    ("code" in detail ? detail.code : undefined) ??
    (typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code
      : undefined);
  return {
    ...(typeof status === "number" && { http_status: status }),
    error_code:
      typeof code === "string" && /^[\w-]{1,64}$/.test(code)
        ? code
        : error instanceof OpenAI.APIConnectionError
          ? "connection_error"
          : "unknown",
  };
}

export async function withLlmFallback<T>(
  request: (fallback?: LlmCredentials) => Promise<T>,
  {
    service = "llm",
    operation,
    model,
    signal,
    shouldFallback = isLlmProviderError,
    getResultTelemetry,
  }: LlmFallbackOptions<T>,
): Promise<T> {
  return await attempt("primary");

  async function attempt(
    api: "primary" | "fallback",
    credentials?: LlmCredentials,
  ): Promise<T> {
    const started = performance.now();
    const attributes = { service, operation, model, api };
    let response: T;
    try {
      response = await request(credentials);
    } catch (error) {
      const canceled = signal?.aborted === true;
      const fallback =
        api === "primary" && !canceled && shouldFallback(error)
          ? getFallbackCredentials(service)
          : undefined;
      emitLlmProviderAttempt({
        ...attributes,
        outcome: canceled ? "canceled" : "failed",
        duration_ms: performance.now() - started,
        will_use_fallback: fallback !== undefined,
        ...(canceled ? {} : getFailureAttributes(error)),
      });
      if (!fallback) throw error;
      logError("Retrying request with fallback credentials", {
        service,
        operation,
      });
      const mainFailure = { error };
      try {
        const result = await attempt("fallback", fallback);
        if (typeof result === "object" && result !== null) {
          mainProviderFailures.set(result, mainFailure);
        }
        return result;
      } catch (fallbackError) {
        if (signal?.aborted) throw fallbackError;
        const failure =
          typeof fallbackError === "object" && fallbackError !== null
            ? fallbackError
            : new Error(String(fallbackError), { cause: fallbackError });
        mainProviderFailures.set(failure, mainFailure);
        throw failure;
      }
    }
    const result = getResultTelemetry?.(response);
    emitLlmProviderAttempt({
      ...attributes,
      ...result,
      outcome: result?.error_code ? "failed" : "success",
      duration_ms: performance.now() - started,
      will_use_fallback: false,
    });
    return response;
  }
}

function getFallbackCredentials(
  service: "llm" | "embedder",
): LlmCredentials | undefined {
  const apiKey =
    service === "embedder"
      ? APP_ENV.FALLBACK_EMBEDDER_API_KEY
      : APP_ENV.FALLBACK_LLM_API_KEY;
  if (!apiKey) return undefined;
  const baseURL =
    service === "embedder"
      ? (APP_ENV.FALLBACK_EMBEDDER_BASE_URL ?? APP_ENV.EMBEDDER_BASE_URL)
      : (APP_ENV.FALLBACK_LLM_BASE_URL ?? APP_ENV.LLM_BASE_URL);
  return { baseURL, apiKey };
}
