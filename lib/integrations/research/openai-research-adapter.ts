export type ResearchSource = {
  url: string;
  title?: string;
};

export type ResearchAdapterInput = {
  systemPrompt: string;
  userPrompt: string;
};

export type ResearchAdapterOutput = {
  markdown: string;
  sources: ResearchSource[];
  provider: "openai_web_search";
  model: string;
};

export interface ResearchAdapter {
  run(input: ResearchAdapterInput): Promise<ResearchAdapterOutput>;
}

type OpenAIResponse = {
  output_text?: string;
  sources?: Array<{ url?: string; title?: string }>;
  output?: Array<{
    content?: Array<{
      text?: string;
      annotations?: Array<{ url?: string; title?: string }>;
    }>;
  }>;
};

export function createOpenAIResearchAdapter({
  apiKey,
  model,
  webSearchTool = "web_search_preview",
  fetchImplementation = fetch,
}: {
  apiKey: string;
  model: string;
  webSearchTool?: string;
  fetchImplementation?: typeof fetch;
}): ResearchAdapter {
  if (!apiKey.trim()) throw new Error("OpenAI API key is required for research.");

  return {
    async run(input) {
      const response = await fetchImplementation("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          tools: [{ type: webSearchTool }],
          tool_choice: "auto",
          input: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: input.userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI research request failed with status ${response.status}.`);
      }
      const data = (await response.json()) as OpenAIResponse;
      const markdown = extractText(data);
      if (!markdown) {
        throw new Error("OpenAI research response did not contain text.");
      }

      return {
        markdown,
        sources: extractSources(data, markdown),
        provider: "openai_web_search",
        model,
      };
    },
  };
}

export function createOpenAIResearchAdapterFromEnv() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return createOpenAIResearchAdapter({
    apiKey,
    model:
      process.env.OPENAI_RESEARCH_MODEL ||
      process.env.OPENAI_MODEL ||
      "gpt-4.1-mini",
    webSearchTool: process.env.OPENAI_WEB_SEARCH_TOOL || "web_search_preview",
  });
}

function extractText(data: OpenAIResponse) {
  if (data.output_text?.trim()) return data.output_text.trim();
  return data.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim() ?? "";
}

function extractSources(data: OpenAIResponse, markdown: string) {
  const sources = new Map<string, ResearchSource>();
  for (const source of data.sources ?? []) addSource(sources, source);
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        addSource(sources, annotation);
      }
    }
  }
  for (const match of markdown.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/giu)) {
    addSource(sources, { url: match[1] });
  }
  return [...sources.values()];
}

function addSource(
  sources: Map<string, ResearchSource>,
  source: { url?: string; title?: string },
) {
  if (!source.url || !/^https?:\/\//iu.test(source.url)) return;
  sources.set(source.url, {
    url: source.url,
    ...(source.title?.trim() ? { title: source.title.trim() } : {}),
  });
}
