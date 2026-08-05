import { requestStructuredResponse } from "../../integrations/openai/structured-response";
import {
  productAgentInstructions,
  productArtifactSchema,
} from "../prompts/product-agent";
import type {
  AgentRunRequest,
  ProductArtifact,
  ProductArtifactContent,
  ResearchArtifact,
} from "../project/types";

type ProductDraft = Omit<
  ProductArtifactContent,
  "inputArtifactIds" | "provider" | "model"
>;

export type ProductGenerator = (input: {
  request: AgentRunRequest;
  researchArtifact: ResearchArtifact;
}) => Promise<ProductDraft>;

export async function runProductAgent(
  request: AgentRunRequest,
  researchArtifact: ResearchArtifact,
  artifactId: string,
  createdAt: string,
  generatorOverride?: ProductGenerator,
): Promise<ProductArtifact> {
  assertRequest(request, researchArtifact);
  const model = process.env.OPENAI_PRODUCT_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const generator = generatorOverride ?? createProductGenerator(model);
  const draft = await generator({ request, researchArtifact });

  validateProductDraft(draft);

  return {
    id: artifactId,
    traceId: request.traceId,
    runId: request.runId,
    agentRole: "product",
    type: "product_hypothesis",
    title: `Product hypothesis: ${request.payload.projectGoal.slice(0, 120)}`,
    content: {
      ...draft,
      inputArtifactIds: [researchArtifact.id],
      provider: generatorOverride ? "mock" : "openai_structured",
      model: generatorOverride ? "mock" : model,
    },
    createdAt,
  };
}

function createProductGenerator(model: string): ProductGenerator {
  return async ({ request, researchArtifact }) => {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error("Product integration is not configured: OPENAI_API_KEY is missing.");
    }

    return requestStructuredResponse<ProductDraft>({
      apiKey,
      model,
      instructions: productAgentInstructions,
      input: buildProductInput(request, researchArtifact),
      schemaName: "product_artifact",
      schema: productArtifactSchema,
      maxOutputTokens: 4500,
    });
  };
}

function buildProductInput(
  request: AgentRunRequest,
  researchArtifact: ResearchArtifact,
) {
  return [
    `Цель проекта: ${request.payload.projectGoal}`,
    `Задача Product Agent: ${request.payload.task}`,
    `Research artifact ID: ${researchArtifact.id}`,
    researchArtifact.content.verdict
      ? `Вердикт Research Agent: ${researchArtifact.content.verdict}`
      : "Вердикт Research Agent отдельно не выделен.",
    "Источники Research Agent:",
    ...researchArtifact.content.sources.map(
      (source, index) => `${index + 1}. ${source.title || source.url}: ${source.url}`,
    ),
    "",
    "Research artifact:",
    researchArtifact.content.markdown.slice(0, 60_000),
  ].join("\n");
}

function assertRequest(
  request: AgentRunRequest,
  researchArtifact: ResearchArtifact,
) {
  if (request.requestedBy !== "project") {
    throw new Error("Product Agent can only be started by Project Agent.");
  }
  if (request.targetAgent !== "product") {
    throw new Error("Product Agent received an unsupported target.");
  }
  if (request.depth !== 1) {
    throw new Error("Product Agent must run at depth 1.");
  }
  if (request.traceId !== researchArtifact.traceId) {
    throw new Error("Product and Research artifacts must belong to one trace.");
  }
  if (!request.payload.inputArtifactIds.includes(researchArtifact.id)) {
    throw new Error("Product Agent request does not reference the Research artifact.");
  }
  if (!researchArtifact.content.markdown.trim()) {
    throw new Error("Research artifact is empty.");
  }
  if (!researchArtifact.content.sources.length) {
    throw new Error("Research artifact has no verifiable sources.");
  }
}

function validateProductDraft(draft: ProductDraft) {
  requireText(draft.summary, "summary");
  requireItems(draft.audienceSegments, "audienceSegments");
  requireItems(draft.positioning, "positioning");
  requireText(draft.productHypothesis.audience, "productHypothesis.audience");
  requireText(draft.productHypothesis.problem, "productHypothesis.problem");
  requireText(draft.productHypothesis.solution, "productHypothesis.solution");
  requireText(
    draft.productHypothesis.expectedResult,
    "productHypothesis.expectedResult",
  );
  requireText(draft.offer.promise, "offer.promise");
  requireText(draft.offer.mechanism, "offer.mechanism");
  requireText(draft.mvp.name, "mvp.name");
  requireText(draft.mvp.format, "mvp.format");
  requireItems(draft.mvp.scope, "mvp.scope");
  requireItems(draft.mvp.successCriteria, "mvp.successCriteria");
  requireItems(draft.productLine, "productLine");
  requireText(draft.leadMagnet.title, "leadMagnet.title");
  requireText(draft.leadMagnet.format, "leadMagnet.format");
  requireText(draft.leadMagnet.nextStep, "leadMagnet.nextStep");
  requireItems(draft.evidence, "evidence");
  requireItems(draft.risks, "risks");

  for (const segment of draft.audienceSegments) {
    requireText(segment.name, "audienceSegments.name");
    requireItems(segment.pains, "audienceSegments.pains");
    requireText(segment.desiredOutcome, "audienceSegments.desiredOutcome");
    requireItems(segment.evidence, "audienceSegments.evidence");
  }

  for (const item of draft.productLine) {
    requireText(item.name, "productLine.name");
    requireText(item.format, "productLine.format");
    requireText(item.priceHypothesis, "productLine.priceHypothesis");
    requireText(item.result, "productLine.result");
  }
}

function requireText(value: string, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Product artifact field ${field} is empty.`);
  }
}

function requireItems(value: unknown[], field: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Product artifact field ${field} is empty.`);
  }
}
