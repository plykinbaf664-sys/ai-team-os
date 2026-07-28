import type {
  AgentArtifact,
  AgentRunRequest,
} from "../project/types";

export function runMockResearchAgent(
  request: AgentRunRequest,
  artifactId: string,
  createdAt: string,
): AgentArtifact {
  if (request.requestedBy !== "project") {
    throw new Error("Research Agent can only be started by Project Agent.");
  }

  if (request.targetAgent !== "research") {
    throw new Error("Mock Research Agent received an unsupported target.");
  }

  if (request.depth !== 1) {
    throw new Error("Research Agent must run at depth 1.");
  }

  return {
    id: artifactId,
    traceId: request.traceId,
    runId: request.runId,
    agentRole: "research",
    type: "research_summary",
    title: `Mock research: ${request.payload.projectGoal}`,
    content: [
      "Исследовательский artifact подготовлен в mock-режиме.",
      `Цель проекта: ${request.payload.projectGoal}`,
      `Задача исследования: ${request.payload.task}`,
      "Фактический поиск и внешние источники не использовались.",
    ].join("\n"),
    createdAt,
  };
}
