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

async function processJob(job: AgentJob): Promise<void> {
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

const activeJobs = new Set<Promise<void>>();

function startJob(job: AgentJob): void {
  let task: Promise<void>;
  task = processJob(job).finally(() => activeJobs.delete(task));
  activeJobs.add(task);
}

while (!stopping) {
  if (activeJobs.size >= config.maxConcurrentJobs) {
    await Promise.race(activeJobs);
    continue;
  }
  try {
    const job = await gateway.next();
    if (job) {
      startJob(job);
      continue;
    }
  } catch (error) {
    console.error(error);
  }
  await Promise.race([Bun.sleep(config.pollIntervalMs), ...activeJobs]);
}

await Promise.allSettled(activeJobs);
