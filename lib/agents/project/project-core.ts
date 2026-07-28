import { randomUUID } from "node:crypto";
import { canCallAgent } from "../loop-guard";
import { runMockResearchAgent } from "../research/mock-research-agent";
import type {
  AgentArtifact,
  AgentRunRequest,
  ProjectExecutionReport,
  ProjectPipelineResult,
  ProjectWorkflowState,
} from "./types";

export function runProjectPipeline(goal: string): ProjectPipelineResult {
  const state = createProjectWorkflow(goal);
  const request = createResearchRunRequest(state);

  executeProjectAgentRun(state, request);

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

  return {
    traceId: createId("trace"),
    rootRunId: createId("run"),
    status: "running",
    plan: {
      id: createId("plan"),
      goal: normalizedGoal,
      createdAt,
      stages: [
        {
          id: "research",
          title: "Подготовить первичный research artifact",
          agentRole: "research",
          status: "pending",
        },
      ],
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
    },
  };
}

export function executeProjectAgentRun(
  state: ProjectWorkflowState,
  request: AgentRunRequest,
): AgentArtifact {
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
    const artifact = runMockResearchAgent(
      request,
      createId("artifact"),
      now(),
    );
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
        ? "Project workflow завершён после получения mock Research artifact."
        : "Project workflow остановлен из-за ошибки.",
    startedAt: state.plan.createdAt,
    completedAt: now(),
  };
}

function formatProjectReport(report: ProjectExecutionReport) {
  const artifact = report.artifacts[0];

  return [
    "Project Agent (mock)",
    "",
    report.summary,
    artifact ? artifact.content : "Artifact не создан.",
    "",
    `Статус: ${report.status}`,
    `trace_id: ${report.traceId}`,
  ].join("\n");
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}
