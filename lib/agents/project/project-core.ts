import { randomUUID } from "node:crypto";
import { runFunnelAgent } from "../funnel/funnel-agent";
import { canCallAgent } from "../loop-guard";
import { runProductAgent } from "../product/product-agent";
import { runResearchAgent } from "../research/research-agent";
import type {
  AgentArtifact,
  AgentRunRequest,
  FunnelArtifact,
  ProductArtifact,
  ProjectExecutionReport,
  ProjectPipelineResult,
  ProjectWorkflowState,
  ResearchArtifact,
} from "./types";

type AgentRunner = (
  request: AgentRunRequest,
  artifactId: string,
  createdAt: string,
) => Promise<AgentArtifact>;

type ResearchAgentRunner = (
  request: AgentRunRequest,
  artifactId: string,
  createdAt: string,
) => Promise<ResearchArtifact>;

type ProductAgentRunner = (
  request: AgentRunRequest,
  researchArtifact: ResearchArtifact,
  artifactId: string,
  createdAt: string,
) => Promise<ProductArtifact>;

type FunnelAgentRunner = (
  request: AgentRunRequest,
  researchArtifact: ResearchArtifact,
  productArtifact: ProductArtifact,
  artifactId: string,
  createdAt: string,
) => Promise<FunnelArtifact>;

export async function runProjectPipeline(
  goal: string,
  {
    researchRunner = runResearchAgent,
    productRunner = runProductAgent,
    funnelRunner = runFunnelAgent,
  }: {
    researchRunner?: ResearchAgentRunner;
    productRunner?: ProductAgentRunner;
    funnelRunner?: FunnelAgentRunner;
  } = {},
): Promise<ProjectPipelineResult> {
  const state = createProjectWorkflow(goal);

  try {
    const researchArtifact = await executeProjectAgentRun(
      state,
      createResearchRunRequest(state),
      researchRunner,
    );

    if (researchArtifact.agentRole !== "research") {
      throw new Error("Research stage returned an incompatible artifact.");
    }

    let productArtifact: ProductArtifact | undefined;

    if (state.plan.stages.some((stage) => stage.agentRole === "product")) {
      const productRequest = createProductRunRequest(state, researchArtifact);
      const artifact = await executeProjectAgentRun(
        state,
        productRequest,
        (request, artifactId, createdAt) =>
          productRunner(
            request,
            researchArtifact,
            artifactId,
            createdAt,
          ),
      );

      if (artifact.agentRole !== "product") {
        throw new Error("Product stage returned an incompatible artifact.");
      }
      productArtifact = artifact;
    }

    if (state.plan.stages.some((stage) => stage.agentRole === "funnel")) {
      if (!productArtifact) {
        throw new Error("Funnel stage requires a completed Product artifact.");
      }
      const funnelRequest = createFunnelRunRequest(
        state,
        researchArtifact,
        productArtifact,
      );
      await executeProjectAgentRun(
        state,
        funnelRequest,
        (request, artifactId, createdAt) =>
          funnelRunner(
            request,
            researchArtifact,
            productArtifact,
            artifactId,
            createdAt,
          ),
      );
    }
  } catch {
    // Run and workflow statuses are recorded by executeProjectAgentRun.
  }

  const report = finalizeProjectWorkflow(state);

  return {
    state,
    report,
    text: formatProjectReport(report),
  };
}

export function createProjectWorkflow(goal: string): ProjectWorkflowState {
  const normalizedGoal = goal.trim();

  if (!normalizedGoal) {
    throw new Error("Project goal is required.");
  }

  const createdAt = now();
  const needsFunnel = requiresFunnelStage(normalizedGoal);
  const stages: ProjectWorkflowState["plan"]["stages"] = [
    {
      id: "research",
      title: "Подготовить первичный Research artifact",
      agentRole: "research",
      status: "pending",
    },
  ];

  if (requiresProductStage(normalizedGoal) || needsFunnel) {
    stages.push({
      id: "product",
      title: "Сформировать продуктовую гипотезу на основе Research artifact",
      agentRole: "product",
      status: "pending",
    });
  }

  if (needsFunnel) {
    stages.push({
      id: "funnel",
      title: "Построить измеримую воронку на основе Product artifact",
      agentRole: "funnel",
      status: "pending",
    });
  }

  return {
    traceId: createId("trace"),
    rootRunId: createId("run"),
    status: "running",
    plan: {
      id: createId("plan"),
      goal: normalizedGoal,
      createdAt,
      stages,
    },
    agentRuns: [],
    artifacts: [],
    payloadFingerprints: [],
  };
}

export function createResearchRunRequest(
  state: ProjectWorkflowState,
): AgentRunRequest {
  return {
    runId: createId("run"),
    traceId: state.traceId,
    parentRunId: state.rootRunId,
    requestedBy: "project",
    targetAgent: "research",
    depth: 1,
    payload: {
      task: `Исследовать цель клиентского проекта: ${state.plan.goal}`,
      projectGoal: state.plan.goal,
      inputArtifactIds: [],
    },
  };
}

export function createProductRunRequest(
  state: ProjectWorkflowState,
  researchArtifact: ResearchArtifact,
): AgentRunRequest {
  if (!state.plan.stages.some((stage) => stage.agentRole === "product")) {
    throw new Error("Product stage is not part of this project plan.");
  }
  if (
    researchArtifact.traceId !== state.traceId ||
    !state.artifacts.some((artifact) => artifact.id === researchArtifact.id)
  ) {
    throw new Error("Research artifact does not belong to this workflow.");
  }

  return {
    runId: createId("run"),
    traceId: state.traceId,
    parentRunId: state.rootRunId,
    requestedBy: "project",
    targetAgent: "product",
    depth: 1,
    payload: {
      task: "Создать продуктовую гипотезу, оффер, MVP и продуктовую линейку на основе Research artifact.",
      projectGoal: state.plan.goal,
      inputArtifactIds: [researchArtifact.id],
    },
  };
}

export function createFunnelRunRequest(
  state: ProjectWorkflowState,
  researchArtifact: ResearchArtifact,
  productArtifact: ProductArtifact,
): AgentRunRequest {
  if (!state.plan.stages.some((stage) => stage.agentRole === "funnel")) {
    throw new Error("Funnel stage is not part of this project plan.");
  }
  const inputArtifacts = [researchArtifact, productArtifact];
  if (
    inputArtifacts.some(
      (artifact) =>
        artifact.traceId !== state.traceId ||
        !state.artifacts.some((stored) => stored.id === artifact.id),
    )
  ) {
    throw new Error("Funnel input artifacts do not belong to this workflow.");
  }

  return {
    runId: createId("run"),
    traceId: state.traceId,
    parentRunId: state.rootRunId,
    requestedBy: "project",
    targetAgent: "funnel",
    depth: 1,
    payload: {
      task: "Построить измеримую воронку от точки входа до целевого оффера.",
      projectGoal: state.plan.goal,
      inputArtifactIds: [researchArtifact.id, productArtifact.id],
    },
  };
}

export async function executeProjectAgentRun(
  state: ProjectWorkflowState,
  request: AgentRunRequest,
  runner: AgentRunner,
): Promise<AgentArtifact> {
  assertRunRequest(state, request);

  const fingerprint = createPayloadFingerprint(request);

  if (state.payloadFingerprints.includes(fingerprint)) {
    throw new Error("Duplicate agent payload inside the same trace.");
  }

  state.payloadFingerprints.push(fingerprint);

  const stage = state.plan.stages.find(
    (candidate) => candidate.agentRole === request.targetAgent,
  );

  if (!stage) {
    throw new Error("Project stage for agent run was not found.");
  }

  stage.status = "running";
  state.agentRuns.push({
    request,
    status: "running",
  });

  try {
    const artifact = await runner(request, createId("artifact"), now());
    assertAgentArtifact(request, artifact);
    const run = state.agentRuns.at(-1);

    if (!run) {
      throw new Error("Agent run state was not created.");
    }

    run.status = "completed";
    run.artifactId = artifact.id;
    stage.status = "completed";
    state.artifacts.push(artifact);

    return artifact;
  } catch (error) {
    const run = state.agentRuns.at(-1);

    if (run) {
      run.status = "failed";
      run.errorMessage =
        error instanceof Error ? error.message : "Unknown specialist Agent error.";
    }

    stage.status = "failed";
    state.status = "failed";
    throw error;
  }
}

export function finalizeProjectWorkflow(
  state: ProjectWorkflowState,
): ProjectExecutionReport {
  if (state.status === "failed") {
    return createReport(state, "failed");
  }

  if (state.plan.stages.some((stage) => stage.status !== "completed")) {
    throw new Error("Project workflow cannot finish with incomplete stages.");
  }

  state.status = "completed";
  return createReport(state, "completed");
}

function assertRunRequest(
  state: ProjectWorkflowState,
  request: AgentRunRequest,
) {
  if (state.status !== "running") {
    throw new Error("Project workflow is already finished.");
  }

  if (
    request.traceId !== state.traceId ||
    request.parentRunId !== state.rootRunId
  ) {
    throw new Error("Agent run does not belong to this workflow.");
  }

  if (
    !canCallAgent({
      callerRole: request.requestedBy,
      targetRole: request.targetAgent,
      depth: request.depth - 1,
    })
  ) {
    throw new Error("Agent run violates the loop guard.");
  }
}

function assertAgentArtifact(
  request: AgentRunRequest,
  artifact: AgentArtifact,
) {
  if (
    artifact.traceId !== request.traceId ||
    artifact.runId !== request.runId ||
    artifact.agentRole !== request.targetAgent
  ) {
    throw new Error("Agent returned an artifact for another run or role.");
  }
}

function createPayloadFingerprint(request: AgentRunRequest) {
  return [
    request.traceId,
    request.targetAgent,
    JSON.stringify(request.payload),
  ].join(":");
}

function createReport(
  state: ProjectWorkflowState,
  status: ProjectExecutionReport["status"],
): ProjectExecutionReport {
  const completedRoles = state.plan.stages
    .filter((stage) => stage.status === "completed")
    .map((stage) => stage.agentRole);
  const failedRole = state.plan.stages.find(
    (stage) => stage.status === "failed",
  )?.agentRole;

  return {
    traceId: state.traceId,
    planId: state.plan.id,
    status,
    completedStageIds: state.plan.stages
      .filter((stage) => stage.status === "completed")
      .map((stage) => stage.id),
    artifacts: [...state.artifacts],
    summary:
      status === "completed"
        ? `Project workflow завершён. Готовы: ${completedRoles.join(", ")}.`
        : `Project workflow остановлен на этапе ${failedRole || "specialist"}; готовые artifacts сохранены.`,
    startedAt: state.plan.createdAt,
    completedAt: now(),
  };
}

function formatProjectReport(report: ProjectExecutionReport) {
  const researchArtifact = report.artifacts.find(
    (artifact): artifact is ResearchArtifact => artifact.agentRole === "research",
  );
  const productArtifact = report.artifacts.find(
    (artifact): artifact is ProductArtifact => artifact.agentRole === "product",
  );
  const funnelArtifact = report.artifacts.find(
    (artifact): artifact is FunnelArtifact => artifact.agentRole === "funnel",
  );
  const details: string[] = [];

  if (researchArtifact) {
    details.push(
      `Research: ${researchArtifact.title}`,
      researchArtifact.content.verdict ??
        "Полный вывод и источники сохранены в Research artifact.",
      `Источников: ${researchArtifact.content.sources.length}`,
    );
  }

  if (productArtifact) {
    details.push(
      "",
      `Product: ${productArtifact.content.summary}`,
      `Оффер: ${productArtifact.content.offer.promise}`,
      `MVP: ${productArtifact.content.mvp.name}`,
    );
  }

  if (funnelArtifact) {
    details.push(
      "",
      `Funnel: ${funnelArtifact.content.summary}`,
      `Вход: ${funnelArtifact.content.entryPoint.channel}`,
      `Этапов: ${funnelArtifact.content.stages.length}`,
    );
  }

  return [
    "Project Agent",
    "",
    report.summary,
    details.length ? details.join("\n") : "Artifact не создан.",
    "",
    `Статус: ${report.status}`,
    `trace_id: ${report.traceId}`,
  ].join("\n");
}

function requiresProductStage(goal: string) {
  return /\b(?:product|offer|mvp)\b|продукт|оффер|позиционир|линейк|упаков/iu.test(
    goal,
  );
}

function requiresFunnelStage(goal: string) {
  return /\b(?:funnel|customer journey)\b|воронк|прогрев|путь клиент/iu.test(
    goal,
  );
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}
