import assert from "node:assert/strict";
import test from "node:test";
import { canCallAgent } from "../lib/agents/loop-guard";
import { runProductAgent } from "../lib/agents/product/product-agent";
import {
  createProductRunRequest,
  createProjectWorkflow,
  createResearchRunRequest,
  executeProjectAgentRun,
  runProjectPipeline,
} from "../lib/agents/project/project-core";
import type {
  AgentRunRequest,
  ProductArtifactContent,
  ResearchArtifact,
} from "../lib/agents/project/types";

test("Product Agent creates a typed artifact from the Research artifact", async () => {
  const state = createProjectWorkflow(
    "Создать продуктовую гипотезу для корпоративных AI-ассистентов",
  );
  const researchRequest = createResearchRunRequest(state);
  const researchArtifact = await executeProjectAgentRun(
    state,
    researchRequest,
    fakeResearchRunner,
  );
  assert.equal(researchArtifact.agentRole, "research");

  const productRequest = createProductRunRequest(state, researchArtifact);
  const productArtifact = await runProductAgent(
    productRequest,
    researchArtifact,
    "artifact_product",
    "2026-08-05T10:00:00.000Z",
    async () => productDraft(),
  );

  assert.equal(productArtifact.type, "product_hypothesis");
  assert.deepEqual(productArtifact.content.inputArtifactIds, [researchArtifact.id]);
  assert.equal(productArtifact.content.provider, "mock");
  assert.equal(productArtifact.content.audienceSegments[0].name, "Малые агентства");
});

test("Project Agent runs Research then Product as independent depth-one runs", async () => {
  const order: string[] = [];
  const pipeline = await runProjectPipeline(
    "Исследуй нишу и создай продукт, оффер и MVP",
    {
      researchRunner: async (...args) => {
        order.push("research");
        return fakeResearchRunner(...args);
      },
      productRunner: async (request, research, artifactId, createdAt) => {
        order.push("product");
        return runProductAgent(
          request,
          research,
          artifactId,
          createdAt,
          async () => productDraft(),
        );
      },
    },
  );

  assert.deepEqual(order, ["research", "product"]);
  assert.equal(pipeline.report.status, "completed");
  assert.deepEqual(pipeline.report.completedStageIds, ["research", "product"]);
  assert.equal(pipeline.state.agentRuns.length, 2);
  assert.ok(
    pipeline.state.agentRuns.every(
      (run) =>
        run.request.depth === 1 &&
        run.request.parentRunId === pipeline.state.rootRunId,
    ),
  );
  assert.deepEqual(
    pipeline.state.agentRuns[1].request.payload.inputArtifactIds,
    [pipeline.state.artifacts[0].id],
  );
  assert.match(pipeline.text, /Оффер:/u);
  assert.match(pipeline.text, /MVP:/u);
});

test("research-only goal does not spend a Product Agent call", async () => {
  let productCalls = 0;
  const pipeline = await runProjectPipeline("Исследуй рынок AI-ассистентов", {
    researchRunner: fakeResearchRunner,
    productRunner: async () => {
      productCalls += 1;
      throw new Error("Product should not run.");
    },
  });

  assert.equal(productCalls, 0);
  assert.equal(pipeline.report.status, "completed");
  assert.equal(pipeline.state.agentRuns.length, 1);
  assert.deepEqual(pipeline.report.completedStageIds, ["research"]);
});

test("Product failure stops workflow but preserves completed Research artifact", async () => {
  const pipeline = await runProjectPipeline("Создай продукт и MVP", {
    researchRunner: fakeResearchRunner,
    productRunner: async () => {
      throw new Error("Product artifact failed validation.");
    },
  });

  assert.equal(pipeline.report.status, "failed");
  assert.equal(pipeline.report.artifacts.length, 1);
  assert.equal(pipeline.report.artifacts[0].agentRole, "research");
  assert.equal(pipeline.state.agentRuns[1].status, "failed");
  assert.match(
    pipeline.state.agentRuns[1].errorMessage ?? "",
    /failed validation/iu,
  );
});

test("specialist agents cannot start Product Agent", () => {
  assert.equal(
    canCallAgent({ callerRole: "research", targetRole: "product", depth: 0 }),
    false,
  );
  assert.equal(
    canCallAgent({ callerRole: "product", targetRole: "research", depth: 0 }),
    false,
  );
});

async function fakeResearchRunner(
  request: AgentRunRequest,
  artifactId: string,
  createdAt: string,
): Promise<ResearchArtifact> {
  return {
    id: artifactId,
    traceId: request.traceId,
    runId: request.runId,
    agentRole: "research",
    type: "research_summary",
    title: "Research: AI-ассистенты",
    content: {
      markdown: [
        "# Research Report",
        "",
        "## Рынок",
        "Малым агентствам сложно внедрять AI без технической команды.",
        "",
        "## Вердикт",
        "Сначала проверить спрос через платный пилот.",
      ].join("\n"),
      filename: "research.md",
      sources: [{ url: "https://example.com/research", title: "Research" }],
      provider: "mock",
      model: "mock",
      verdict: "Сначала проверить спрос через платный пилот.",
    },
    createdAt,
  };
}

function productDraft(): Omit<
  ProductArtifactContent,
  "inputArtifactIds" | "provider" | "model"
> {
  return {
    summary: "Платный пилот внедрения AI для малых агентств.",
    audienceSegments: [
      {
        name: "Малые агентства",
        pains: ["Нет внутренней AI-команды"],
        desiredOutcome: "Запустить рабочий AI-процесс",
        evidence: ["Проблема отмечена в Research artifact"],
      },
    ],
    positioning: ["Внедрение одного измеримого AI-процесса за короткий пилот"],
    productHypothesis: {
      audience: "Малые агентства",
      problem: "Не хватает технической команды",
      solution: "Пилот внедрения одного AI-процесса",
      expectedResult: "Рабочий процесс и измеримый эффект",
    },
    offer: {
      promise: "Запустить один рабочий AI-процесс",
      mechanism: "Диагностика, настройка и контролируемый пилот",
      proofNeeded: ["Кейс первого пилота"],
    },
    mvp: {
      name: "AI Process Sprint",
      format: "Платный пилот",
      scope: ["Диагностика", "Настройка одного процесса"],
      successCriteria: ["Процесс используется командой"],
    },
    productLine: [
      {
        name: "AI Process Sprint",
        format: "Пилот",
        priceHypothesis: "Проверить через интервью и первые продажи",
        result: "Один внедрённый процесс",
      },
    ],
    leadMagnet: {
      title: "Карта потерь времени агентства",
      format: "Диагностика",
      nextStep: "Обсуждение платного пилота",
    },
    assumptions: ["Агентства готовы платить за короткий пилот"],
    evidence: ["Research artifact указывает на нехватку технической команды"],
    risks: ["Готовность платить ещё не подтверждена"],
  };
}
