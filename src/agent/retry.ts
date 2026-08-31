const transientRetryDelaysMs = [500, 1_000, 2_000, 4_000, 8_000, 12_000, 16_000] as const;

type ErrorWithCode = { code?: unknown };

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & ErrorWithCode).code;
    return `${error.name} ${typeof code === "string" ? code : ""} ${error.message}`;
  }
  return String(error);
}

export function isTransientNetworkError(error: unknown): boolean {
  const text = errorText(error);
  return (
    /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket connection was closed unexpectedly|fetch failed|connection reset|connection refused|network is unreachable|timed out|timeout|TimeoutError|AbortError/i.test(
      text,
    ) || /\b(?:Gateway|HTTP)\s+5(?:02|03|04)\b/i.test(text)
  );
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = transientRetryDelaysMs,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = delaysMs[attempt];
      if (!isTransientNetworkError(error) || delayMs === undefined) {
        throw error;
      }
      await Bun.sleep(delayMs);
    }
  }
}
