export function throwIfAborted(
  signal?: AbortSignal,
  fallbackAbortReason?: unknown,
): void {
  if (signal?.aborted) {
    throw (
      signal.reason ??
      fallbackAbortReason ??
      new DOMException("Aborted", "AbortError")
    );
  }
}

export function delay(
  ms: number,
  signal?: AbortSignal,
  fallbackAbortReason?: unknown,
): Promise<void> {
  throwIfAborted(signal, fallbackAbortReason);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);

    const abort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason ??
          fallbackAbortReason ??
          new DOMException("Aborted", "AbortError"),
      );
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}
