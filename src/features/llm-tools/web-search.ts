import {
  getWebSearchContextSize,
  type WebSearchContextSize,
} from "../llm-models.ts";

export function createToolDefinition(): {
  type: "web_search";
  search_context_size: WebSearchContextSize;
} {
  return {
    type: "web_search",
    search_context_size: getWebSearchContextSize(),
  };
}
