// bun:test has no Deno-style sub-steps. Steps share their parent test's state,
// so run them in order and report which one failed.
export async function step(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
  } catch (error) {
    throw new Error(`step "${name}" failed`, { cause: error });
  }
}
