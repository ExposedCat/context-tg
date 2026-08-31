import { expect, test } from "bun:test";
import { isTransientNetworkError, retryTransient } from "../src/agent/retry.ts";

test("recognizes a closed gateway socket as transient", () => {
  expect(
    isTransientNetworkError(
      new TypeError(
        "The socket connection was closed unexpectedly. For more information, pass verbose: true",
      ),
    ),
  ).toBe(true);
});

test("recognizes temporary gateway responses as transient", () => {
  expect(isTransientNetworkError(new Error("Gateway 503: service unavailable"))).toBe(true);
  expect(isTransientNetworkError(new Error("Gateway 500: internal error"))).toBe(false);
});

test("retries transient failures with bounded delays", async () => {
  let attempts = 0;
  const value = await retryTransient(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      throw error;
    }
    return "ok";
  }, [0, 0]);

  expect(value).toBe("ok");
  expect(attempts).toBe(3);
});

test("does not retry non-network failures", async () => {
  let attempts = 0;
  await expect(
    retryTransient(async () => {
      attempts += 1;
      throw new Error("invalid request");
    }, [0, 0]),
  ).rejects.toThrow("invalid request");
  expect(attempts).toBe(1);
});
