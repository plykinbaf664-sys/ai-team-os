import { randomUUID } from "node:crypto";
import {
  agentRegistry,
  getAgent,
  type AgentRole,
  type RootAgentRole,
} from "./agent-registry";
import { runAssistantPipeline } from "./assistant/assistant-core";
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

export function routeRootAgentMessage(input: {
  role: RootAgentRole;
  text: string;
}): RouteAgentMessageResult {
  if (input.role === "assistant") {
    const pipeline = runAssistantPipeline(input.text);
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
            status:
              pipeline.outcome.kind === "clarification"
                ? "needs_clarification"
                : pipeline.outcome.kind === "confirmation"
                  ? "needs_confirmation"
                  : "completed",
            depth: 0,
            payload: { source_text: input.text },
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

  const pipeline = runProjectPipeline(input.text);

  return {
    role: "project",
    text: pipeline.text,
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
          },
          output: run.artifactId
            ? { artifact_id: run.artifactId }
            : undefined,
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
        content: { text: artifact.content },
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
  const report = await generateResearchReportMarkdown(input);
  const filename = buildResearchReportFilename(input.text);

  return {
    role: "research",
    text: [
      "Research Agent: готов отчет.",
      "",
      `Файл: ${filename}`,
      "Внутри: срез рынка, спрос, деньги в нише, конкуренты, позиционирование, риски, источники и вердикт по запуску.",
    ].join("\n"),
    document: {
      filename,
      content: report,
      caption: "Research report",
    },
  };
}

async function generateResearchReportMarkdown(input: RouteAgentMessageInput) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return [
      "# Research Report",
      "",
      "OpenAI API key is missing, so live web research could not run.",
      "",
      "Add `OPENAI_API_KEY` to `.env.local` and retry the research request.",
    ].join("\n");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model:
        process.env.OPENAI_RESEARCH_MODEL ||
        process.env.OPENAI_MODEL ||
        "gpt-4.1-mini",
      tools: [
        {
          type: process.env.OPENAI_WEB_SEARCH_TOOL || "web_search_preview",
        },
      ],
      tool_choice: "auto",
      input: [
        {
          role: "system",
          content: buildResearchReportSystemPrompt(),
        },
        {
          role: "user",
          content: buildResearchReportPrompt(input),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI research request failed: ${errorText}`);
  }

  const data = (await response.json()) as OpenAIResponse;
  const text = extractOpenAIText(data);

  if (!text) {
    throw new Error("OpenAI research response did not contain text.");
  }

  return appendSourcesIfNeeded(text, data);
}

function buildResearchReportSystemPrompt() {
  return [
    researchAgentSystemPrompt,
    "",
    "Act as a professional marketing strategist, market analyst, and competitive intelligence expert.",
    "You have access to web search. Use it for current market and competitor research.",
    "Use current internet search. Do not rely only on general knowledge.",
    "Return a polished Markdown document in Russian.",
    "Make citations and source URLs visible in the Markdown.",
    "Prioritize primary sources: competitor landing pages, course pages, pricing pages, social pages, sales pages, webinars, lead magnets, checkout pages, YouTube descriptions, Telegram channels, and ad libraries when available.",
    "Avoid generic market fluff. Every conclusion must be tied to a concrete observation, source, fact, hypothesis, or action.",
    "If you cannot find a concrete price, funnel step, product lineup, lead magnet, or promise, write 'не найдено в доступных источниках'. Do not invent it.",
    "Write harshly, concretely, and practically. Do not use generic phrases like 'важно создавать ценность', 'нужно выделяться', or 'анализируйте аудиторию'.",
    "Your task is to determine whether there is money in the niche, whether the market is alive, whether it is worth entering, which competitors are already making money, where they are strong or weak, which positioning can stand out, and which offers, products, prices, funnels, and meanings should be used.",
    "The competitor section must be a dense table, not paragraphs.",
    "For each competitor include: product/company, URL, target audience, product lineup, core promise, funnel entry, funnel steps, price/payment terms if found, proof/source, positioning weakness, opportunity for us.",
    "After the competitor table, write a short 'What this means for us' section with specific positioning moves.",
    "Do not return JSON.",
    "Use this structure:",
    "# Research Report: <niche>",
    "## 1. Исходные данные",
    "Include niche, geography, target audience if known, product/service format, price segment, and competitor-analysis criteria. If missing, write 'не указано'.",
    "## 2. Срез рынка",
    "Evaluate: market aliveness, demand, signs of money, audience purchasing power, growth/stagnation, trends, competition intensity, entry difficulty, and unmet needs. End with: рынок слабый / средний / сильный and why.",
    "## 3. Деньги в нише",
    "Analyze what people already pay for, bought products/services, likely average checks, where money volume is, monetization formats, whether expensive products can be sold, repeat-sales potential, product-line potential. Give money-potential score 1-10.",
    "## 4. Анализ конкурентов",
    "For each competitor analyze: who they are, what they sell, whom they sell to, positioning, main offer, product lineup, price/segment, site/social/profile packaging, audience pains, communication meanings, strengths, weaknesses, gaps, revenue mechanics, what to copy, and where to differentiate. If data is insufficient, write 'нет данных / нужно проверить / гипотеза'.",
    "## 5. Сравнительная таблица",
    "Columns: competitor, positioning, offer, audience, product, price/segment, strengths, weaknesses, differentiation opportunity, threat level low/medium/high.",
    "## 6. Дыры рынка",
    "Find what competitors do badly, weakly covered pains, unused formats, identical promises, overheated areas, free space, underserved audience segments, and meanings we can own.",
    "## 7. Возможное позиционирование",
    "Offer 3-5 positioning options. For each: essence, audience, main offer, why it can work, difference from competitors, risks, required content and packaging.",
    "## 8. Рекомендация по входу в нишу",
    "Give honest verdict: enter or not, approach, segment, first product, test price, funnel, hypotheses to validate, metrics to track, money-losing mistakes.",
    "## 9. Итоговый вывод как маркетолог",
    "Use this exact format: потенциал ниши: 1-10; уровень конкуренции: 1-10; сложность входа: 1-10; денежность: 1-10; шанс успешного запуска: 1-10; лучший угол входа; главный риск; главная возможность; что делать первым шагом.",
    "## 10. Источники",
  ].join("\n");
}

function buildResearchReportPrompt(input: RouteAgentMessageInput) {
  return [
    `User: ${input.userName}`,
    "Research task from Telegram group chat:",
    input.text,
    "",
    "If the task contains an original niche and later user criteria, keep the original niche as the mandatory research subject. Do not switch to another market or infer a different niche.",
    "If the niche is crypto trading education, the report must stay about crypto trading education and adjacent competitor offers only.",
    "Prepare a practical market research report.",
    "Evaluate whether this niche is alive, whether there is money in it, how frequent and urgent customer demand appears to be, how competitive the space is, and how our launch can stand out.",
    "Do not satisfy the request with broad descriptions. The user needs actionable competitor intelligence.",
    "Use the user's requested criteria exactly. If criteria are missing, default to: offer, price, packaging, content, funnel, reviews, positioning, USP, lead magnet, social media, website, product lineup, audience pains, ad creatives.",
    "If the user provided criteria, use exactly those criteria as the main competitor-analysis columns.",
    "If the user asked for two competitors, analyze exactly two strong relevant competitors. If a stronger competitor is found than the first result, choose the stronger one and explain why.",
    "For crypto trading education, focus on offers that teach trading crypto/crypto markets, not generic investing or unrelated online education.",
    "Use web search and cite sources.",
  ].join("\n");
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

function appendSourcesIfNeeded(text: string, data: OpenAIResponse) {
  if (/^##\s+Sources/im.test(text) || /^##\s+Источники/im.test(text)) {
    return text.trim();
  }

  const sources = extractOpenAISources(data);

  if (!sources.length) {
    return text.trim();
  }

  return [
    text.trim(),
    "",
    "## Sources",
    ...sources.map((source, index) => {
      const title = source.title || source.url;
      return `${index + 1}. [${title}](${source.url})`;
    }),
  ].join("\n");
}

function extractOpenAISources(data: OpenAIResponse) {
  const sources = new Map<string, { url: string; title?: string }>();

  for (const source of data.sources ?? []) {
    if (source.url) {
      sources.set(source.url, {
        url: source.url,
        title: source.title,
      });
    }
  }

  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      for (const annotation of content.annotations ?? []) {
        if (annotation.url) {
          sources.set(annotation.url, {
            url: annotation.url,
            title: annotation.title,
          });
        }
      }
    }
  }

  return Array.from(sources.values());
}

function buildResearchReportFilename(text: string) {
  const date = new Date().toISOString().slice(0, 10);
  const slug =
    text
      .toLowerCase()
      .replace(/[^a-zа-я0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "research";

  return `research-report-${date}-${slug}.md`;
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
