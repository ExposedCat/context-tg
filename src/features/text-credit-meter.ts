import type OpenAI from "openai";
import { countTextTokens, truncateTextTokens } from "./text-tokens.ts";

type Response = OpenAI.Responses.Response;
type TextPart = { text: string; phase?: "commentary" | "final_answer" };

export class TextCreditMeter {
  private parts = new Map<string, TextPart>();
  private phases = new Map<string, TextPart["phase"]>();
  private snapshot?: Response;

  observe(event: OpenAI.Responses.ResponseStreamEvent) {
    if (event.type === "response.created") this.snapshot = event.response;
    if (
      event.type === "response.output_item.added" &&
      event.item.type === "message"
    ) {
      this.phases.set(event.item.id, event.item.phase ?? undefined);
    }
    if (
      event.type === "response.output_text.delta" ||
      event.type === "response.refusal.delta"
    ) {
      const key = `${event.item_id}:${event.content_index}`;
      const part = this.parts.get(key) ?? {
        text: "",
        phase: this.phases.get(event.item_id),
      };
      part.text += event.delta;
      this.parts.set(key, part);
    }
  }

  get tokens() {
    return [...this.parts.values()].reduce(
      (sum, part) => sum + countTextTokens(part.text),
      0,
    );
  }

  complete(response: Response) {
    const streamedParts = this.parts;
    this.parts = new Map();
    for (const item of response.output) {
      if (item.type !== "message") continue;
      for (const [index, part] of item.content.entries()) {
        if (part.type === "output_text" || part.type === "refusal") {
          this.parts.set(`${item.id}:${index}`, {
            text: part.type === "output_text" ? part.text : part.refusal,
            phase: item.phase ?? undefined,
          });
        }
      }
    }
    // Some interrupted terminal events omit the text already delivered in
    // deltas. Keep that text instead of replacing it with an empty snapshot.
    if (response.status !== "completed" && this.parts.size === 0)
      this.parts = streamedParts;
    this.snapshot = response;
  }

  limitedResponse(
    allowance: number,
    notice = "Text credit limit reached.",
  ): Response {
    const output: OpenAI.Responses.ResponseOutputMessage[] = [];
    let remaining = allowance;
    for (const part of this.parts.values()) {
      const text = truncateTextTokens(part.text, remaining);
      remaining -= countTextTokens(text);
      if (text)
        output.push({
          type: "message",
          id: `msg-local-${crypto.randomUUID()}`,
          role: "assistant",
          status: "completed",
          phase: part.phase,
          content: [
            { type: "output_text", text, annotations: [], logprobs: [] },
          ],
        });
    }
    if (notice)
      output.push({
        type: "message",
        id: `msg-local-${crypto.randomUUID()}`,
        role: "assistant",
        status: "completed",
        phase: "final_answer",
        content: [
          {
            type: "output_text",
            text: `\n\n${notice}`,
            annotations: [],
            logprobs: [],
          },
        ],
      });
    // This is a local checkpoint, never a claim that the provider completed the
    // aborted generation. No partial tool arguments are included or executed.
    return {
      ...this.snapshot,
      id: `resp-local-${crypto.randomUUID()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      error: null,
      incomplete_details: null,
      output,
      output_text: "",
      usage: undefined,
    } as Response;
  }
}
