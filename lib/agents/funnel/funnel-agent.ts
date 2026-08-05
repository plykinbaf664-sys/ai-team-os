import { requestStructuredResponse } from "../../integrations/openai/structured-response";
import {
  funnelAgentInstructions,
  funnelArtifactSchema,
} from "../prompts/funnel-agent";
import type {
  AgentRunRequest,
  FunnelArtifact,
  FunnelArtifactContent,
  ProductArtifact,
  ResearchArtifact,
} from "../project/types";

type FunnelDraft = Omit<
  FunnelArtifactContent,
  "inputArtifactIds" | "provider" | "model"
>;

export type FunnelGenerator = (input: {
  request: AgentRunRequest;
  researchArtifact: ResearchArtifact;
  productArtifact: ProductArtifact;
}) => Promise<FunnelDraft>;

export async function runFunnelAgent(
  request: AgentRunRequest,
  researchArtifact: ResearchArtifact,
  productArtifact: ProductArtifact,
  artifactId: string,
  createdAt: string,
  generatorOverride?: FunnelGenerator,
): Promise<FunnelArtifact> {
  assertRequest(request, researchArtifact, productArtifact);
  const model =
    process.env.OPENAI_FUNNEL_MODEL ||
    process.env.OPENAI_MODEL ||
    "gpt-4.1-mini";
  const generator = generatorOverride ?? createFunnelGenerator(model);
  const draft = await generator({
    request,
    researchArtifact,
    productArtifact,
  });

  validateFunnelDraft(draft);

  return {
    id: artifactId,
    traceId: request.traceId,
    runId: request.runId,
    agentRole: "funnel",
    type: "funnel_strategy",
    title: `Funnel strategy: ${request.payload.projectGoal.slice(0, 120)}`,
    content: {
      ...draft,
      inputArtifactIds: [researchArtifact.id, productArtifact.id],
      provider: generatorOverride ? "mock" : "openai_structured",
      model: generatorOverride ? "mock" : model,
    },
    createdAt,
  };
}

function createFunnelGenerator(model: string): FunnelGenerator {
  return async ({ request, researchArtifact, productArtifact }) => {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error(
        "Funnel integration is not configured: OPENAI_API_KEY is missing.",
      );
    }

    return requestStructuredResponse<FunnelDraft>({
      apiKey,
      model,
      instructions: funnelAgentInstructions,
      input: buildFunnelInput(request, researchArtifact, productArtifact),
      schemaName: "funnel_artifact",
      schema: funnelArtifactSchema,
      maxOutputTokens: 4500,
    });
  };
}

function buildFunnelInput(
  request: AgentRunRequest,
  researchArtifact: ResearchArtifact,
  productArtifact: ProductArtifact,
) {
  return [
    `Цель проекта: ${request.payload.projectGoal}`,
    `Задача Funnel Agent: ${request.payload.task}`,
    `Research artifact ID: ${researchArtifact.id}`,
    `Product artifact ID: ${productArtifact.id}`,
    "",
    "Product artifact:",
    JSON.stringify(productArtifact.content),
    "",
    "Research artifact:",
    researchArtifact.content.markdown.slice(0, 45_000),
  ].join("\n");
}

function assertRequest(
  request: AgentRunRequest,
  researchArtifact: ResearchArtifact,
  productArtifact: ProductArtifact,
) {
  if (request.requestedBy !== "project") {
    throw new Error("Funnel Agent can only be started by Project Agent.");
  }
  if (request.targetAgent !== "funnel") {
    throw new Error("Funnel Agent received an unsupported target.");
  }
  if (request.depth !== 1) {
    throw new Error("Funnel Agent must run at depth 1.");
  }
  if (
    request.traceId !== researchArtifact.traceId ||
    request.traceId !== productArtifact.traceId
  ) {
    throw new Error("Funnel input artifacts must belong to one trace.");
  }
  const expectedIds = [researchArtifact.id, productArtifact.id];
  if (!expectedIds.every((id) => request.payload.inputArtifactIds.includes(id))) {
    throw new Error("Funnel Agent request does not reference all input artifacts.");
  }
  if (!researchArtifact.content.sources.length) {
    throw new Error("Research artifact has no verifiable sources.");
  }
  if (!productArtifact.content.evidence.length) {
    throw new Error("Product artifact has no evidence.");
  }
}

function validateFunnelDraft(draft: FunnelDraft) {
  requireText(draft.summary, "summary");
  requireText(draft.entryPoint.channel, "entryPoint.channel");
  requireText(draft.entryPoint.audience, "entryPoint.audience");
  requireText(draft.entryPoint.promise, "entryPoint.promise");
  requireText(draft.leadMagnet.title, "leadMagnet.title");
  requireText(draft.leadMagnet.format, "leadMagnet.format");
  requireText(draft.leadMagnet.value, "leadMagnet.value");
  requireText(draft.leadMagnet.nextStep, "leadMagnet.nextStep");
  requireItems(draft.stages, "stages");
  requireItems(draft.conversionEvents, "conversionEvents");
  requireItems(draft.touchpoints, "touchpoints");
  requireText(draft.handoff.targetOffer, "handoff.targetOffer");
  requireItems(
    draft.handoff.qualificationCriteria,
    "handoff.qualificationCriteria",
  );
  requireItems(draft.metrics, "metrics");
  requireItems(draft.evidence, "evidence");
  requireItems(draft.risks, "risks");

  for (const stage of draft.stages) {
    requireText(stage.name, "stages.name");
    requireText(stage.objective, "stages.objective");
    requireText(stage.userAction, "stages.userAction");
    requireText(stage.systemResponse, "stages.systemResponse");
    requireText(stage.successMetric, "stages.successMetric");
  }
}

function requireText(value: string, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Funnel artifact field ${field} is empty.`);
  }
}

function requireItems(value: unknown[], field: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Funnel artifact field ${field} is empty.`);
  }
}
