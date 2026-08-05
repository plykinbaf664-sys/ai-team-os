import assert from "node:assert/strict";
import test from "node:test";
import {
  createResearchRunRequest,
  createProjectWorkflow,
  executeProjectAgentRun,
  runProjectPipeline,
} from "../lib/agents/project/project-core";
import {
  runResearchAgent,
  runResearchTask,
} from "../lib/agents/research/research-agent";
import { routeRootAgentMessage } from "../lib/agents/agent-router";
import {
  createOpenAIResearchAdapter,
  type ResearchAdapter,
} from "../lib/integrations/research/openai-research-adapter";

const MARKDOWN = [
  "# Research Report: корпоративные AI-ассистенты",
  "",
  "## 1. Исходные данные",
  "Исследуется рынок корпоративных AI-ассистентов для малого бизнеса.",
  "",
  "## 2. Срез рынка",
  "Рынок активен; вывод основан на официальных страницах продуктов.",
  "",
  "## 9. Итоговый вывод как маркетолог",
  "Вердикт: сначала тестировать узкий сегмент агентств.",
  "",
  "## 10. Источники",
  "1. [OpenAI](https://openai.com/enterprise)",
].join("\n");

test("OpenAI adapter uses web search and returns deduplicated sources", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = createOpenAIResearchAdapter({
    apiKey: "test-key",
    model: "research-model",
    fetchImplementation: (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        output_text: MARKDOWN,
        sources: [
          { url: "https://openai.com/enterprise", title: "OpenAI Enterprise" },
        ],
        output: [
          {
            content: [
              {
                text: MARKDOWN,
                annotations: [
                  { url: "https://openai.com/enterprise", title: "OpenAI" },
                ],
              },
            ],
          },
        ],
      });
    }) as typeof fetch,
  });
  const result = await adapter.run({
    systemPrompt: "system",
    userPrompt: "task",
  });

  assert.equal(result.model, "research-model");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, "https://openai.com/enterprise");
  assert.deepEqual(body?.tools, [{ type: "web_search_preview" }]);
});

test("Project Agent completes a real Research run with a structured artifact", async () => {
  const adapter = fakeResearchAdapter();
  const pipeline = await runProjectPipeline(
    "Исследовать рынок корпоративных AI-ассистентов",
    {
      researchRunner: (request, artifactId, createdAt) =>
        runResearchAgent(request, artifactId, createdAt, adapter),
    },
  );

  assert.equal(pipeline.report.status, "completed");
  assert.equal(pipeline.state.agentRuns.length, 1);
  assert.equal(pipeline.state.agentRuns[0].request.requestedBy, "project");
  assert.equal(pipeline.state.agentRuns[0].request.depth, 1);
  assert.equal(
    pipeline.state.agentRuns[0].request.parentRunId,
    pipeline.state.rootRunId,
  );
  const artifact = pipeline.report.artifacts[0];
  assert.equal(artifact.content.provider, "openai_web_search");
  assert.equal(artifact.content.sources.length, 1);
  assert.match(artifact.content.markdown, /Research Report/);
  assert.match(artifact.content.verdict ?? "", /сначала тестировать/iu);
  assert.doesNotMatch(pipeline.text, /mock/iu);
});

test("Project workflow stops and stores no artifact when sources are missing", async () => {
  const adapter = fakeResearchAdapter({ sources: [] });
  const pipeline = await runProjectPipeline("Исследовать нишу", {
    researchRunner: (request, artifactId, createdAt) =>
      runResearchAgent(request, artifactId, createdAt, adapter),
  });

  assert.equal(pipeline.report.status, "failed");
  assert.equal(pipeline.report.artifacts.length, 0);
  assert.equal(pipeline.state.agentRuns[0].status, "failed");
  assert.match(
    pipeline.state.agentRuns[0].errorMessage ?? "",
    /no verifiable sources/iu,
  );
});

test("the same Research payload cannot run twice inside one trace", async () => {
  const state = createProjectWorkflow("Исследовать рынок");
  const request = createResearchRunRequest(state);
  const runner = (input: typeof request, artifactId: string, createdAt: string) =>
    runResearchAgent(input, artifactId, createdAt, fakeResearchAdapter());

  await executeProjectAgentRun(state, request, runner);
  await assert.rejects(
    () => executeProjectAgentRun(state, request, runner),
    /workflow is already finished|Duplicate agent payload/iu,
  );
});

test("direct Research and Project Research use the same validated adapter", async () => {
  const result = await runResearchTask(
    {
      task: "Найди деньги и конкурентов",
      projectGoal: "Проверить нишу AI-ассистентов",
    },
    fakeResearchAdapter(),
  );

  assert.equal(result.provider, "openai_web_search");
  assert.match(result.filename, /^research-report-/u);
  assert.match(result.markdown, /https:\/\/openai\.com\/enterprise/u);
});

test("root Project routing persists the structured Research artifact", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    Response.json({
      output_text: MARKDOWN,
      sources: [
        { url: "https://openai.com/enterprise", title: "OpenAI Enterprise" },
      ],
    })) as typeof fetch;

  try {
    const result = await routeRootAgentMessage({
      role: "project",
      text: "Исследуй рынок корпоративных AI-ассистентов",
    });

    assert.equal(result.role, "project");
    assert.ok(result.document);
    assert.equal(result.persistence?.artifacts.length, 1);
    assert.equal(
      result.persistence?.artifacts[0].content.provider,
      "openai_web_search",
    );
    assert.ok(Array.isArray(result.persistence?.artifacts[0].content.sources));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

function fakeResearchAdapter(
  overrides: Partial<Awaited<ReturnType<ResearchAdapter["run"]>>> = {},
): ResearchAdapter {
  return {
    run: async () => ({
      markdown: MARKDOWN,
      sources: [
        { url: "https://openai.com/enterprise", title: "OpenAI Enterprise" },
      ],
      provider: "openai_web_search",
      model: "research-model",
      ...overrides,
    }),
  };
}
