import { randomUUID } from "node:crypto";
import {
  agentRegistry,
  getAgent,
  type AgentRole,
  type RootAgentRole,
} from "./agent-registry";
import { runAssistantPipeline } from "./assistant/assistant-core";
import type { AssistantConversationMessage } from "./assistant/types";
import type { AssistantProjectContext } from "./assistant/project-context";
import { runProjectPipeline } from "./project/project-core";
import { canCallAgent } from "./loop-guard";
import type {
  AgentPersistenceEnvelope,
  JsonObject,
  JsonValue,
  PersistenceAction,
} from "../database/types";
import {
  buildProjectAssistantPrompt,
  projectAssistantSystemPrompt,
} from "./prompts/project-assistant";
import {
  buildResearchAgentPrompt,
  researchAgentSystemPrompt,
} from "./prompts/research-agent";
import { runResearchTask } from "./research/research-agent";

type RouteAgentMessageInput = {
  role: AgentRole;
  text: string;
  chatId: number;
  userName: string;
};

type RouteAgentMessageResult = {
  role: AgentRole;
  text: string;
  document?: {
    filename: string;
    content: string;
    caption?: string;
  };
  persistence?: AgentPersistenceEnvelope;
};

type OpenAIResponse = {
  output_text?: string;
  sources?: Array<{
    url?: string;
    title?: string;
  }>;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        title?: string;
      }>;
    }>;
  }>;
};

export async function routeRootAgentMessage(input: {
  role: RootAgentRole;
  text: string;
  conversation?: AssistantConversationMessage[];
  assistantContext?: {
    telegramUserId: number;
    telegramChatId: number;
    projectContext?: AssistantProjectContext;
  };
}): Promise<RouteAgentMessageResult> {
  if (input.role === "assistant") {
    const pipeline = await runAssistantPipeline(input.text, {
      conversation: input.conversation,
      projectContext: input.assistantContext?.projectContext,
    });
    const traceId = createRuntimeId("trace");
    const rootRunId = createRuntimeId("run");

    return {
      role: "assistant",
      text: pipeline.text,
      persistence: {
        traceId,
        rootRunId,
        runs: [
          {
            id: rootRunId,
            traceId,
            role: "assistant",
            status: mapAssistantRunStatus(pipeline),
            depth: 0,
            payload: {
              source_text: input.text,
              ...(pipeline.projectContext?.activeProject
                ? {
                    project_id: pipeline.projectContext.activeProject.id,
                  }
                : {}),
            },
            output: {
              outcome: pipeline.outcome.kind,
              response_text: pipeline.text,
            },
          },
        ],
        actions:
          pipeline.outcome.kind === "ready"
            ? pipeline.outcome.plan.actions.map((action) => {
                const result = pipeline.results.find(
                  (candidate) => candidate.actionId === action.id,
                );

                return {
                  externalActionId: action.id,
                  actionType: action.type,
                  projectId: pipeline.projectContext?.activeProject?.id,
                  payload: toJsonObject(action.payload),
                  status: mapActionRequestStatus(result?.status),
                  result,
                } satisfies PersistenceAction;
              })
            : [],
        confirmations:
          pipeline.outcome.kind === "confirmation"
            ? [
                {
                  prompt: pipeline.outcome.prompt,
                  reason: pipeline.outcome.reason,
                  operationSummary: pipeline.outcome.operationSummary,
                },
              ]
            : [],
        artifacts: [],
      },
    };
  }

  const pipeline = await runProjectPipeline(input.text);
  const researchArtifact = pipeline.report.artifacts.find(
    (artifact) => artifact.agentRole === "research",
  );

  return {
    role: "project",
    text: pipeline.text,
    ...(researchArtifact
      ? {
          document: {
            filename: researchArtifact.content.filename,
            content: researchArtifact.content.markdown,
            caption: researchArtifact.title,
          },
        }
      : {}),
    persistence: {
      traceId: pipeline.state.traceId,
      rootRunId: pipeline.state.rootRunId,
      runs: [
        {
          id: pipeline.state.rootRunId,
          traceId: pipeline.state.traceId,
          role: "project",
          status: pipeline.report.status,
          depth: 0,
          payload: { goal: pipeline.state.plan.goal },
          output: {
            plan_id: pipeline.state.plan.id,
            summary: pipeline.report.summary,
          },
        },
        ...pipeline.state.agentRuns.map((run) => ({
          id: run.request.runId,
          traceId: run.request.traceId,
          parentRunId: run.request.parentRunId,
          role: run.request.targetAgent,
          status: run.status,
          depth: run.request.depth,
          payload: {
            task: run.request.payload.task,
            project_goal: run.request.payload.projectGoal,
            input_artifact_ids: run.request.payload.inputArtifactIds,
          },
          output: createProjectRunOutput(
            run.artifactId,
            run.errorMessage,
          ),
        })),
      ],
      actions: [],
      confirmations: [],
      artifacts: pipeline.state.artifacts.map((artifact) => ({
        id: artifact.id,
        traceId: artifact.traceId,
        runId: artifact.runId,
        type: artifact.type,
        title: artifact.title,
        content: toJsonObject(artifact.content),
        createdAt: artifact.createdAt,
      })),
    },
  };
}

function mapActionRequestStatus(
  resultStatus:
    | "succeeded"
    | "failed"
    | "needs_clarification"
    | "needs_confirmation"
    | undefined,
): PersistenceAction["status"] {
  if (resultStatus === "succeeded") {
    return "completed";
  }

  return resultStatus ?? "ready";
}

function mapAssistantRunStatus(
  pipeline: Awaited<ReturnType<typeof runAssistantPipeline>>,
) {
  if (pipeline.outcome.kind === "clarification") {
    return "needs_clarification" as const;
  }
  if (pipeline.outcome.kind === "confirmation") {
    return "needs_confirmation" as const;
  }
  if (
    pipeline.outcome.kind === "ready" &&
    pipeline.outcome.plan.strategicPlan?.clarification
  ) {
    return "needs_clarification" as const;
  }
  if (pipeline.results.some((result) => result.status === "needs_confirmation")) {
    return "needs_confirmation" as const;
  }
  if (pipeline.results.some((result) => result.status === "needs_clarification")) {
    return "needs_clarification" as const;
  }
  if (
    pipeline.results.length > 0 &&
    pipeline.results.every((result) => result.status === "failed")
  ) {
    return "failed" as const;
  }
  return "completed" as const;
}

function createProjectRunOutput(
  artifactId?: string,
  errorMessage?: string,
): JsonObject | undefined {
  if (artifactId) return { artifact_id: artifactId };
  if (errorMessage) return { error: errorMessage };
  return undefined;
}

function toJsonObject(value: unknown): JsonObject {
  const converted = toJsonValue(value);

  if (
    typeof converted !== "object" ||
    converted === null ||
    Array.isArray(converted)
  ) {
    throw new Error("Expected a JSON object.");
  }

  return converted;
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Non-finite numbers cannot be persisted as JSON.");
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (typeof value === "object") {
    const result: JsonObject = {};

    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        result[key] = toJsonValue(entry);
      }
    }

    return result;
  }

  throw new Error("Unsupported JSON value.");
}

function createRuntimeId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export async function routeAgentMessage(
  input: RouteAgentMessageInput,
): Promise<RouteAgentMessageResult> {
  if (isStatusCommand(input.text)) {
    return {
      role: "project",
      text: buildProjectStatusMessage(),
    };
  }

  const agent = getAgent(input.role);

  if (!agent.enabled) {
    return {
      role: input.role,
      text: `${agent.displayName} is not enabled yet.`,
    };
  }

  const researchDelegationText = getResearchDelegationText(input.text);

  if (input.role === "project" && researchDelegationText) {
    if (
      !canCallAgent({
        callerRole: "project",
        targetRole: "research",
        depth: 0,
      })
    ) {
      return {
        role: "project",
        text: "Project Assistant не может передать задачу Research Agent в текущем режиме.",
      };
    }

    const researchResult = await routeDelegatedResearchAgent({
      ...input,
      role: "research",
      text: researchDelegationText,
    });

    return {
      role: "project",
      text: [
        "Project Assistant -> Research Agent",
        "",
        "Передаю задачу Research Agent.",
        "",
        "Research Agent:",
        researchResult.text,
      ].join("\n"),
      document: researchResult.document,
    };
  }

  if (input.role === "research" && shouldAskCompetitorClarification(input.text)) {
    return {
      role: "research",
      text: [
        "Перед анализом конкурентов уточни, пожалуйста:",
        "",
        "1. Сколько конкурентов нужно разобрать?",
        "2. По каким критериям сравнивать?",
        "",
        "Например: `research 5 конкурентов, критерии: цена, ЦА, позиционирование, каналы продаж, сильные стороны`.",
      ].join("\n"),
    };
  }

  if (input.role === "research") {
    return generateResearchReportResult(input);
  }

  const prompt = buildAgentPrompt(input);
  const systemPrompt = getAgentSystemPrompt(input.role);

  return {
    role: input.role,
    text: await generateAgentReply({ prompt, systemPrompt }),
  };
}

async function routeDelegatedResearchAgent(
  input: RouteAgentMessageInput,
): Promise<RouteAgentMessageResult> {
  const agent = getAgent("research");

  if (!agent.enabled) {
    return {
      role: "research",
      text: `${agent.displayName} is not enabled yet.`,
    };
  }

  if (shouldAskCompetitorClarification(input.text)) {
    return {
      role: "research",
      text: buildCompetitorClarificationMessage(),
    };
  }

  return generateResearchReportResult(input);
}

async function generateResearchReportResult(
  input: RouteAgentMessageInput,
): Promise<RouteAgentMessageResult> {
  const report = await runResearchTask({
    task: input.text,
    projectGoal: input.text,
    userName: input.userName,
  });

  return {
    role: "research",
    text: [
      "Research Agent: готов отчет.",
      "",
      `Файл: ${report.filename}`,
      "Внутри: срез рынка, спрос, деньги в нише, конкуренты, позиционирование, риски, источники и вердикт по запуску.",
    ].join("\n"),
    document: {
      filename: report.filename,
      content: report.markdown,
      caption: "Research report",
    },
  };
}

async function generateAgentReply({
  prompt,
  systemPrompt,
}: {
  prompt: string;
  systemPrompt: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return [
      "Project Assistant на связи.",
      "",
      "Я вижу задачу, но `OPENAI_API_KEY` пока не настроен. Для MVP следующий шаг:",
      "1. Добавить `OPENAI_API_KEY` в `.env.local`.",
      "2. Настроить Telegram webhook на `/api/telegram/webhook`.",
      "3. Написать в группе: `project сделай план запуска MVP`.",
    ].join("\n");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${errorText}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  const text = extractOpenAIText(data);

  if (!text) {
    throw new Error("OpenAI response did not contain text.");
  }

  return text;
}

function extractOpenAIText(data: OpenAIResponse) {
  if (data.output_text) {
    return data.output_text.trim();
  }

  return data.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildAgentPrompt(input: RouteAgentMessageInput) {
  if (input.role === "research") {
    return buildResearchAgentPrompt({
      userText: input.text,
      userName: input.userName,
    });
  }

  return buildProjectAssistantPrompt({
    userText: input.text,
    userName: input.userName,
  });
}

function getAgentSystemPrompt(role: AgentRole) {
  if (role === "research") {
    return researchAgentSystemPrompt;
  }

  return projectAssistantSystemPrompt;
}

function shouldAskCompetitorClarification(text: string) {
  const asksForCompetitors = /\bcompetitors?\b|конкур/i.test(text);

  if (!asksForCompetitors) {
    return false;
  }

  const hasCount = /\d+|одн|дв|тр|четыр|пят|шест|сем|восем|девят|десят/i.test(text);
  const hasCriteria =
    /\bcriteria\b|критери|позиционирован|продуктов|линейк|обещан|воронк|цена|ценообразован|целевая аудитория|ЦА|канал|сильн|слаб/i.test(
      text,
    );

  return !hasCount || !hasCriteria;
}

function getResearchDelegationText(text: string) {
  if (!/(передай|делегируй|delegate|assign)/i.test(text)) {
    return null;
  }

  const match = text.match(/(?:research|ресерч)\s+([\s\S]+)/i);

  if (!match) {
    return null;
  }

  return match[1]
    .replace(/^(начать|сделать|задачу|пожалуйста)\s+/i, "")
    .trim();
}

function buildCompetitorClarificationMessage() {
  return [
    "Перед анализом конкурентов уточни, пожалуйста:",
    "",
    "1. Сколько конкурентов нужно разобрать?",
    "2. По каким критериям сравнивать конкурентов?",
    "3. Нужен ли общий срез по рынку ниши: деньги, спрос, горячесть темы, боли аудитории и вердикт по запуску?",
    "",
    "Например: `research 5 конкурентов, критерии: цена, ЦА, позиционирование, каналы продаж, сильные стороны; плюс срез рынка и вердикт по запуску`.",
  ].join("\n");
}

function isStatusCommand(text: string) {
  return /^(status|статус)$/i.test(text.trim());
}

function buildProjectStatusMessage() {
  const enabledAgents = Object.values(agentRegistry)
    .filter((agent) => agent.enabled)
    .map((agent) => agent.displayName)
    .join(", ");

  const disabledAgents = Object.values(agentRegistry)
    .filter((agent) => !agent.enabled)
    .map((agent) => agent.displayName)
    .join(", ");

  return [
    "AI Team OS status",
    "",
    `Webhook: online`,
    `Project Assistant: active`,
    `OpenAI API key: ${formatConfigured(process.env.OPENAI_API_KEY)}`,
    `Telegram bot token: ${formatConfigured(process.env.TELEGRAM_BOT_TOKEN)}`,
    `Webhook secret: ${formatConfigured(process.env.TELEGRAM_WEBHOOK_SECRET)}`,
    `OpenAI model: ${process.env.OPENAI_MODEL || "gpt-4.1-mini"}`,
    "",
    `Enabled agents: ${enabledAgents || "none"}`,
    `Disabled agents: ${disabledAgents || "none"}`,
    "",
    "Prefixes: project, проджект",
    "Diagnostics: project status, проджект status",
  ].join("\n");
}

function formatConfigured(value: string | undefined) {
  return value ? "configured" : "missing";
}
