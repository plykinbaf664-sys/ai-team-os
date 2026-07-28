import type { SpecialistAgentRole } from "../agent-registry";

export type ProjectWorkflowStatus =
  | "running"
  | "completed"
  | "failed"
  | "needs_clarification";

export type ProjectStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type ProjectStage = {
  id: string;
  title: string;
  agentRole: SpecialistAgentRole;
  status: ProjectStageStatus;
};

export type ProjectPlan = {
  id: string;
  goal: string;
  stages: ProjectStage[];
  createdAt: string;
};

export type AgentRunRequest = {
  runId: string;
  traceId: string;
  parentRunId: string;
  requestedBy: "project";
  targetAgent: SpecialistAgentRole;
  depth: number;
  payload: {
    task: string;
    projectGoal: string;
  };
};

export type AgentRunRecord = {
  request: AgentRunRequest;
  status: "running" | "completed" | "failed";
  artifactId?: string;
};

export type AgentArtifact = {
  id: string;
  traceId: string;
  runId: string;
  agentRole: SpecialistAgentRole;
  type: "research_summary";
  title: string;
  content: string;
  createdAt: string;
};

export type ProjectWorkflowState = {
  traceId: string;
  rootRunId: string;
  status: ProjectWorkflowStatus;
  plan: ProjectPlan;
  agentRuns: AgentRunRecord[];
  artifacts: AgentArtifact[];
  payloadFingerprints: string[];
};

export type ProjectExecutionReport = {
  traceId: string;
  planId: string;
  status: "completed" | "failed";
  completedStageIds: string[];
  artifacts: AgentArtifact[];
  summary: string;
  startedAt: string;
  completedAt: string;
};

export type ProjectPipelineResult = {
  state: ProjectWorkflowState;
  report: ProjectExecutionReport;
  text: string;
};
