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
    inputArtifactIds: string[];
  };
};

export type AgentRunRecord = {
  request: AgentRunRequest;
  status: "running" | "completed" | "failed";
  artifactId?: string;
  errorMessage?: string;
};

export type ResearchArtifactContent = {
  markdown: string;
  filename: string;
  sources: Array<{
    url: string;
    title?: string;
  }>;
  provider: "openai_web_search" | "mock";
  model: string;
  verdict?: string;
};

export type ProductArtifactContent = {
  summary: string;
  audienceSegments: Array<{
    name: string;
    pains: string[];
    desiredOutcome: string;
    evidence: string[];
  }>;
  positioning: string[];
  productHypothesis: {
    audience: string;
    problem: string;
    solution: string;
    expectedResult: string;
  };
  offer: {
    promise: string;
    mechanism: string;
    proofNeeded: string[];
  };
  mvp: {
    name: string;
    format: string;
    scope: string[];
    successCriteria: string[];
  };
  productLine: Array<{
    name: string;
    format: string;
    priceHypothesis: string;
    result: string;
  }>;
  leadMagnet: {
    title: string;
    format: string;
    nextStep: string;
  };
  assumptions: string[];
  evidence: string[];
  risks: string[];
  inputArtifactIds: string[];
  provider: "openai_structured" | "mock";
  model: string;
};

export type FunnelArtifactContent = {
  summary: string;
  entryPoint: {
    channel: string;
    audience: string;
    promise: string;
  };
  leadMagnet: {
    title: string;
    format: string;
    value: string;
    nextStep: string;
  };
  stages: Array<{
    name: string;
    objective: string;
    userAction: string;
    systemResponse: string;
    successMetric: string;
  }>;
  conversionEvents: Array<{
    name: string;
    fromStage: string;
    toStage: string;
    measurement: string;
  }>;
  touchpoints: Array<{
    stage: string;
    channel: string;
    messageGoal: string;
  }>;
  handoff: {
    targetOffer: string;
    qualificationCriteria: string[];
  };
  metrics: Array<{
    name: string;
    definition: string;
    targetHypothesis: string;
  }>;
  assumptions: string[];
  evidence: string[];
  risks: string[];
  inputArtifactIds: string[];
  provider: "openai_structured" | "mock";
  model: string;
};

type AgentArtifactBase = {
  id: string;
  traceId: string;
  runId: string;
  title: string;
  createdAt: string;
};

export type ResearchArtifact = AgentArtifactBase & {
  agentRole: "research";
  type: "research_summary";
  content: ResearchArtifactContent;
};

export type ProductArtifact = AgentArtifactBase & {
  agentRole: "product";
  type: "product_hypothesis";
  content: ProductArtifactContent;
};

export type FunnelArtifact = AgentArtifactBase & {
  agentRole: "funnel";
  type: "funnel_strategy";
  content: FunnelArtifactContent;
};

export type AgentArtifact =
  | ResearchArtifact
  | ProductArtifact
  | FunnelArtifact;

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
