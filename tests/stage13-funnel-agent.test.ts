import assert from "node:assert/strict";
import test from "node:test";
import { runFunnelAgent } from "../lib/agents/funnel/funnel-agent";
import {
  createFunnelRunRequest,
  createProductRunRequest,
  createProjectWorkflow,
  createResearchRunRequest,
  executeProjectAgentRun,
  runProjectPipeline,
} from "../lib/agents/project/project-core";
import type {
  AgentRunRequest,
  FunnelArtifactContent,
  ProductArtifact,
  ResearchArtifact,
} from "../lib/agents/project/types";

test("Project Agent runs Research, Product and Funnel as separate depth-one runs", async () => {
  const order: string[] = [];
  const pipeline = await runProjectPipeline(
    "Исследуй нишу, создай продукт и построй воронку продаж",
    {
      researchRunner: async (...args) => {
        order.push("research");
        return researchArtifact(...args);
      },
      productRunner: async (request, research, artifactId, createdAt) => {
        order.push("product");
        return productArtifact(request, research, artifactId, createdAt);
      },
      funnelRunner: async (
        request,
        research,
        product,
        artifactId,
        createdAt,
      ) => {
        order.push("funnel");
        return runFunnelAgent(
          request,
          research,
          product,
          artifactId,
          createdAt,
          async () => funnelDraft(),
        );
      },
    },
  );

  assert.deepEqual(order, ["research", "product", "funnel"]);
  assert.equal(pipeline.report.status, "completed");
  assert.deepEqual(pipeline.report.completedStageIds, [
    "research",
    "product",
    "funnel",
  ]);
  assert.ok(
    pipeline.state.agentRuns.every(
      (run) =>
        run.request.depth === 1 &&
        run.request.parentRunId === pipeline.state.rootRunId,
    ),
  );
  assert.deepEqual(
    pipeline.state.agentRuns[2].request.payload.inputArtifactIds,
    pipeline.state.artifacts.slice(0, 2).map((artifact) => artifact.id),
  );
  assert.match(pipeline.text, /Funnel:/u);
  assert.match(pipeline.text, /Этапов: 2/u);
});

test("product-only goal does not spend a Funnel Agent call", async () => {
  let funnelCalls = 0;
  const pipeline = await runProjectPipeline("Создай продукт и MVP", {
    researchRunner: researchArtifact,
    productRunner: productArtifact,
    funnelRunner: async () => {
      funnelCalls += 1;
      throw new Error("Funnel should not run.");
    },
  });

  assert.equal(funnelCalls, 0);
  assert.deepEqual(pipeline.report.completedStageIds, ["research", "product"]);
});

test("Funnel Agent rejects a request without both source artifacts", async () => {
  const state = createProjectWorkflow("Построй воронку продаж");
  const research = await executeProjectAgentRun(
    state,
    createResearchRunRequest(state),
    researchArtifact,
  );
  assert.equal(research.agentRole, "research");
  const productRequest = createProductRunRequest(state, research);
  const product = await executeProjectAgentRun(
    state,
    productRequest,
    (request, artifactId, createdAt) =>
      productArtifact(request, research, artifactId, createdAt),
  );
  assert.equal(product.agentRole, "product");
  const funnelRequest = createFunnelRunRequest(state, research, product);
  funnelRequest.payload.inputArtifactIds = [research.id];

  await assert.rejects(
    () =>
      runFunnelAgent(
        funnelRequest,
        research,
        product,
        "artifact_funnel",
        "2026-08-05T10:00:00.000Z",
        async () => funnelDraft(),
      ),
    /does not reference all input artifacts/iu,
  );
});

test("Funnel failure preserves completed Research and Product artifacts", async () => {
  const pipeline = await runProjectPipeline("Создай продукт и воронку", {
    researchRunner: researchArtifact,
    productRunner: productArtifact,
    funnelRunner: async () => {
      throw new Error("Funnel artifact failed validation.");
    },
  });

  assert.equal(pipeline.report.status, "failed");
  assert.deepEqual(
    pipeline.report.artifacts.map((artifact) => artifact.agentRole),
    ["research", "product"],
  );
  assert.equal(pipeline.state.agentRuns[2].status, "failed");
});

async function researchArtifact(
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
    title: "Research",
    content: {
      markdown: "# Research\n\nМалым агентствам нужен понятный AI-процесс.",
      filename: "research.md",
      sources: [{ url: "https://example.com/research" }],
      provider: "mock",
      model: "mock",
    },
    createdAt,
  };
}

async function productArtifact(
  request: AgentRunRequest,
  research: ResearchArtifact,
  artifactId: string,
  createdAt: string,
): Promise<ProductArtifact> {
  return {
    id: artifactId,
    traceId: request.traceId,
    runId: request.runId,
    agentRole: "product",
    type: "product_hypothesis",
    title: "Product",
    content: {
      summary: "Платный AI-пилот для агентств.",
      audienceSegments: [
        {
          name: "Малые агентства",
          pains: ["Нет AI-команды"],
          desiredOutcome: "Рабочий процесс",
          evidence: ["Research"],
        },
      ],
      positioning: ["Один внедрённый процесс"],
      productHypothesis: {
        audience: "Малые агентства",
        problem: "Нет AI-команды",
        solution: "Платный пилот",
        expectedResult: "Рабочий процесс",
      },
      offer: {
        promise: "Внедрить один AI-процесс",
        mechanism: "Диагностика и пилот",
        proofNeeded: ["Первый кейс"],
      },
      mvp: {
        name: "AI Sprint",
        format: "Пилот",
        scope: ["Диагностика"],
        successCriteria: ["Процесс используется"],
      },
      productLine: [
        {
          name: "AI Sprint",
          format: "Пилот",
          priceHypothesis: "Проверить продажами",
          result: "Один процесс",
        },
      ],
      leadMagnet: {
        title: "Карта потерь времени",
        format: "Диагностика",
        nextStep: "Пилот",
      },
      assumptions: ["Есть готовность платить"],
      evidence: ["Проблема подтверждена Research artifact"],
      risks: ["Цена не проверена"],
      inputArtifactIds: [research.id],
      provider: "mock",
      model: "mock",
    },
    createdAt,
  };
}

function funnelDraft(): Omit<
  FunnelArtifactContent,
  "inputArtifactIds" | "provider" | "model"
> {
  return {
    summary: "Диагностика переводит квалифицированное агентство в платный пилот.",
    entryPoint: {
      channel: "Партнёрский outreach",
      audience: "Владельцы малых агентств",
      promise: "Найти процесс с максимальной потерей времени",
    },
    leadMagnet: {
      title: "Карта потерь времени",
      format: "Диагностика",
      value: "Приоритетный процесс для автоматизации",
      nextStep: "Разбор результата",
    },
    stages: [
      {
        name: "Диагностика",
        objective: "Выявить проблему",
        userAction: "Заполнить вопросы",
        systemResponse: "Сформировать карту",
        successMetric: "Завершённая диагностика",
      },
      {
        name: "Пилот",
        objective: "Продать внедрение",
        userAction: "Согласовать пилот",
        systemResponse: "Зафиксировать scope",
        successMetric: "Оплаченный пилот",
      },
    ],
    conversionEvents: [
      {
        name: "Переход в пилот",
        fromStage: "Диагностика",
        toStage: "Пилот",
        measurement: "Доля согласованных пилотов",
      },
    ],
    touchpoints: [
      {
        stage: "Диагностика",
        channel: "Telegram",
        messageGoal: "Получить заполненные ответы",
      },
    ],
    handoff: {
      targetOffer: "AI Sprint",
      qualificationCriteria: ["Есть конкретный процесс"],
    },
    metrics: [
      {
        name: "Диагностика → пилот",
        definition: "Согласованные пилоты / завершённые диагностики",
        targetHypothesis: "Определить после первых 10 диагностик",
      },
    ],
    assumptions: ["Диагностика создаёт достаточную ценность"],
    evidence: ["Lead magnet и оффер взяты из Product artifact"],
    risks: ["Конверсия пока не подтверждена"],
  };
}
