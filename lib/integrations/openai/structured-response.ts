type FetchImplementation = typeof fetch;

type OpenAIResponseContent = {
  type?: string;
  text?: string;
  refusal?: string;
};

type OpenAIResponse = {
  status?: string;
  output_text?: string;
  incomplete_details?: {
    reason?: string;
  };
  output?: Array<{
    type?: string;
    content?: OpenAIResponseContent[];
  }>;
  error?: {
    message?: string;
  };
};

export async function requestStructuredResponse<T>({
  apiKey,
  model,
  instructions,
  input,
  schemaName,
  schema,
  maxOutputTokens = 1800,
  fetchImplementation = fetch,
}: {
  apiKey: string;
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  fetchImplementation?: FetchImplementation;
}): Promise<T> {
  const response = await fetchImplementation(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: maxOutputTokens,
        instructions,
        input,
        text: {
          format: {
            type: "json_schema",
            name: schemaName,
            strict: true,
            schema,
          },
        },
      }),
    },
  );

  const data = (await response.json()) as OpenAIResponse;

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
        `OpenAI structured response failed with status ${response.status}.`,
    );
  }

  if (data.status === "incomplete") {
    throw new Error(
      `OpenAI structured response is incomplete: ${
        data.incomplete_details?.reason || "unknown reason"
      }.`,
    );
  }

  const refusal = data.output
    ?.flatMap((item) => item.content ?? [])
    .find((content) => content.type === "refusal")
    ?.refusal?.trim();

  if (refusal) {
    throw new Error(`OpenAI refused the planner request: ${refusal}`);
  }

  const outputText =
    data.output_text?.trim() ||
    data.output
      ?.flatMap((item) => item.content ?? [])
      .filter((content) => content.type === "output_text")
      .map((content) => content.text)
      .filter(Boolean)
      .join("\n")
      .trim();

  if (!outputText) {
    throw new Error("OpenAI structured response did not contain output text.");
  }

  try {
    return JSON.parse(outputText) as T;
  } catch {
    throw new Error("OpenAI structured response contained invalid JSON.");
  }
}
