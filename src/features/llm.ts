import OpenAI from "@openai/openai";
import { APP_ENV } from "./env.ts";

export const TOOL_DEFINITIONS = {
	web_search: {
		type: "web_search",
		search_context_size: "low",
	},
} as const;

export type ToolName = keyof typeof TOOL_DEFINITIONS;

export type LlmCitation = {
	start_index: number;
	end_index: number;
	link: string;
};

export type LlmSource = {
	link: string;
};

export type LlmResponse = {
	response?: string;
	web_search: {
		used: boolean;
		citations: LlmCitation[];
		sources: LlmSource[];
	};
	tools: ToolName[];
};

type ToolDefinition = (typeof TOOL_DEFINITIONS)[ToolName];

type ApiResponse = {
	output: ApiResponseOutputItem[];
	output_text?: string;
};

type ApiResponseOutputItem = {
	type: string;
	action?: unknown;
	content?: unknown;
};

type WebSearchAction = {
	type: string;
	sources?: Array<{ url?: string | null }>;
	url?: string | null;
};

type OutputTextContent = {
	type: "output_text";
	annotations: Array<{
		type: string;
		start_index?: number;
		end_index?: number;
		url?: string;
	}>;
};

function getClient(): OpenAI {
	return new OpenAI({
		apiKey: APP_ENV.LLM_API_KEY,
		baseURL: APP_ENV.LLM_BASE_URL,
	});
}

function getToolDefinitions(tools: ToolName[]): ToolDefinition[] {
	return tools.map((tool) => TOOL_DEFINITIONS[tool]);
}

function isOutputText(content: unknown): content is OutputTextContent {
	return (
		typeof content === "object" &&
		content !== null &&
		"type" in content &&
		content.type === "output_text"
	);
}

function isMessageItem(
	item: ApiResponseOutputItem,
): item is ApiResponseOutputItem & { type: "message"; content: unknown[] } {
	return item.type === "message" && Array.isArray(item.content);
}

function isWebSearchAction(action: unknown): action is WebSearchAction {
	return typeof action === "object" && action !== null && "type" in action;
}

function isWebSearchCall(
	item: ApiResponseOutputItem,
): item is ApiResponseOutputItem & {
	type: "web_search_call";
	action: WebSearchAction;
} {
	return item.type === "web_search_call" && isWebSearchAction(item.action);
}

function pushUniqueLink(links: string[], link: string | null | undefined) {
	if (!link || links.includes(link)) {
		return;
	}

	links.push(link);
}

function getCitations(response: ApiResponse): LlmCitation[] {
	return response.output.flatMap((item) => {
		if (!isMessageItem(item)) {
			return [];
		}

		return item.content.flatMap((content) => {
			if (!isOutputText(content)) {
				return [];
			}

			return content.annotations
				.filter(
					(annotation) =>
						annotation.type === "url_citation" &&
						typeof annotation.start_index === "number" &&
						typeof annotation.end_index === "number" &&
						typeof annotation.url === "string",
				)
				.map((annotation) => ({
					start_index: annotation.start_index as number,
					end_index: annotation.end_index as number,
					link: annotation.url as string,
				}));
		});
	});
}

function getWebSearchSourceLinks(response: ApiResponse): string[] {
	const links: string[] = [];

	for (const item of response.output) {
		if (!isWebSearchCall(item)) {
			continue;
		}

		switch (item.action.type) {
			case "search":
				for (const source of item.action.sources ?? []) {
					pushUniqueLink(links, source.url);
				}
				break;
			case "open_page":
			case "find_in_page":
				pushUniqueLink(links, item.action.url);
				break;
		}
	}

	return links;
}

function getCalledTools(response: ApiResponse): ToolName[] {
	const calledTools = new Set<ToolName>();

	for (const item of response.output) {
		if (item.type === "web_search_call") {
			calledTools.add("web_search");
		}
	}

	return [...calledTools];
}

export async function requestLlm(
	request: string,
	tools: ToolName[],
	responseId?: number,
): Promise<LlmResponse> {
	const response = await getClient().responses.create({
		model: APP_ENV.LLM_MODEL,
		input: request,
		temperature: APP_ENV.LLM_TEMPERATURE,
		tools: getToolDefinitions(tools),
		tool_choice: "auto",
		include: tools.includes("web_search")
			? ["web_search_call.action.sources"]
			: undefined,
		previous_response_id:
			responseId === undefined ? undefined : String(responseId),
	});

	const citations = getCitations(response);
	const citationLinks = new Set(citations.map((citation) => citation.link));
	const sources = getWebSearchSourceLinks(response)
		.filter((link) => !citationLinks.has(link))
		.map((link) => ({ link }));
	const calledTools = getCalledTools(response);
	const responseText = response.output_text || undefined;

	return {
		response: responseText,
		web_search: {
			used: calledTools.includes("web_search"),
			citations,
			sources,
		},
		tools: calledTools,
	};
}
