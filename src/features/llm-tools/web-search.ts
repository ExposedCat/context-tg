import {
  getWebSearchContextSize,
  type WebSearchContextSize,
  type WebSearchSetting,
} from "../llm-models.ts";

export function createToolDefinition(setting?: WebSearchSetting): {
  type: "web_search";
  search_context_size: WebSearchContextSize;
} {
  return {
    type: "web_search",
    search_context_size: getWebSearchContextSize(setting),
  };
}
