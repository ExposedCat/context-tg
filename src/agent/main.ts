import type { AgentJob } from "../shared/types.ts";
import { loadBuckets } from "./buckets.ts";
import { runCodex } from "./codex.ts";
import { loadAgentConfig } from "./config.ts";
import { GatewayClient } from "./gateway.ts";
import { buildPrompt } from "./prompt.ts";

const config = loadAgentConfig();
const gateway = new GatewayClient(config.bridgeUrl, config.bridgeToken);
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

while (!stopping) {
  let job: AgentJob | null;
  try {
    job = await gateway.next();
  } catch (error) {
    console.error(error);
    await Bun.sleep(2_000);
    continue;
  }
  if (!job) {
    await Bun.sleep(config.pollIntervalMs);
    continue;
  }

  try {
    const buckets = await loadBuckets(config.memoryPath, `${job.prompt}\n${job.context}`);
    const prompt = buildPrompt(job, buckets);
    const result = await runCodex(config, prompt, job.resumeThreadId, async (event) => {
      await gateway.event(job.id, event);
    });
    await gateway.complete(job.id, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", jobId: job.id, message }));
    await gateway.fail(job.id, message);
  }
}
