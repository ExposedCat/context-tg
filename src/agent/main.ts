import type { AgentJob } from "../shared/types.ts";
import { loadBuckets } from "./buckets.ts";
import { runCodex } from "./codex.ts";
import { loadAgentConfig } from "./config.ts";
import { GatewayClient } from "./gateway.ts";
import { buildPrompt } from "./prompt.ts";

const config = loadAgentConfig();
const gateway = new GatewayClient(config.bridgeUrl, config.bridgeToken);
let stopping = false;
const leaseHeartbeatIntervalMs = 20_000;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

async function monitorCancellation(jobId: number, controller: AbortController): Promise<void> {
  let nextHeartbeatAt = Date.now() + leaseHeartbeatIntervalMs;
  while (!controller.signal.aborted) {
    try {
      if (await gateway.isCancelled(jobId)) {
        controller.abort();
        return;
      }
      if (Date.now() >= nextHeartbeatAt) {
        if (!(await gateway.heartbeat(jobId))) {
          controller.abort();
          return;
        }
        nextHeartbeatAt = Date.now() + leaseHeartbeatIntervalMs;
      }
    } catch {
      // A transient bridge failure should not stop a running job. Retry on the next poll.
    }
    if (!controller.signal.aborted) {
      await Bun.sleep(500);
    }
  }
}

async function cancellationRequested(jobId: number, controller: AbortController): Promise<boolean> {
  if (controller.signal.aborted) {
    return true;
  }
  try {
    return await gateway.isCancelled(jobId);
  } catch {
    return false;
  }
}

async function processJob(job: AgentJob): Promise<void> {
  const cancellation = new AbortController();
  const cancellationMonitor = monitorCancellation(job.id, cancellation);
  try {
    if (await cancellationRequested(job.id, cancellation)) {
      return;
    }
    const buckets = await loadBuckets(config.memoryPath, `${job.prompt}\n${job.context}`);
    const prompt = buildPrompt(job, buckets);
    const result = await runCodex(
      config,
      prompt,
      job.resumeThreadId,
      async (event) => {
        await gateway.event(job.id, event);
      },
      cancellation.signal,
    );
    if (await cancellationRequested(job.id, cancellation)) {
      return;
    }
    await gateway.complete(job.id, result);
  } catch (error) {
    if (await cancellationRequested(job.id, cancellation)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ level: "error", jobId: job.id, message }));
    await gateway.fail(job.id, message);
  } finally {
    cancellation.abort();
    await cancellationMonitor;
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
