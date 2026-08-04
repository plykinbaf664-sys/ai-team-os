import type { AssistantConversationMessage } from "./types";

export type AssistantProjectResource = {
  id: string;
  projectId: string;
  resourceType: "google_sheet" | "ticktick_project";
  externalId: string;
  title: string;
  metadata: Record<string, unknown>;
};

export type AssistantProjectCandidate = {
  id: string;
  name: string;
  status: string;
  goal?: string;
  stage?: string;
  kpis: string[];
  aliases: string[];
  resources: AssistantProjectResource[];
  updatedAt?: string;
};

export type AssistantProjectMemory = {
  userId?: string;
  timezone?: string;
  preferredResponseStyle?: string;
  activeProjectId?: string;
  projects: AssistantProjectCandidate[];
};

export type AssistantProjectDetails = {
  glossary: Array<{
    term: string;
    definition: string;
    aliases: string[];
  }>;
  operatingRules: Array<{
    key: string;
    text: string;
    priority: number;
  }>;
  decisions: Array<{
    decision: string;
    rationale?: string;
    createdAt?: string;
  }>;
  recentActions: Array<{
    actionType: string;
    status: string;
    payload: Record<string, unknown>;
    createdAt?: string;
  }>;
};

export type AssistantProjectContext = {
  telegramUserId: number;
  telegramChatId: number;
  timezone?: string;
  preferredResponseStyle?: string;
  resolution: "resolved" | "ambiguous" | "none";
  resolutionReason: string;
  confidence: number;
  activeProject?: AssistantProjectCandidate & AssistantProjectDetails;
  candidates: AssistantProjectCandidate[];
};

export type AssistantProjectContextStore = {
  getAssistantProjectMemory(
    telegramUserId: number,
  ): Promise<AssistantProjectMemory>;
  getAssistantProjectDetails(
    projectId: string,
  ): Promise<AssistantProjectDetails>;
};

const EMPTY_DETAILS: AssistantProjectDetails = {
  glossary: [],
  operatingRules: [],
  decisions: [],
  recentActions: [],
};

export async function loadAssistantProjectContext({
  store,
  telegramUserId,
  telegramChatId,
  sourceText,
  conversation = [],
}: {
  store: AssistantProjectContextStore | null;
  telegramUserId: number;
  telegramChatId: number;
  sourceText: string;
  conversation?: AssistantConversationMessage[];
}): Promise<AssistantProjectContext> {
  if (!store) {
    return emptyContext(
      telegramUserId,
      telegramChatId,
      "Project memory storage is not configured.",
    );
  }

  const memory = await store.getAssistantProjectMemory(telegramUserId);
  const resolution = resolveActiveProject({
    memory,
    sourceText,
    conversation,
  });

  if (!resolution.project) {
    return {
      telegramUserId,
      telegramChatId,
      timezone: memory.timezone,
      preferredResponseStyle: memory.preferredResponseStyle,
      resolution: resolution.kind,
      resolutionReason: resolution.reason,
      confidence: resolution.confidence,
      candidates: memory.projects,
    };
  }

  const details = await store.getAssistantProjectDetails(
    resolution.project.id,
  );

  return {
    telegramUserId,
    telegramChatId,
    timezone: memory.timezone,
    preferredResponseStyle: memory.preferredResponseStyle,
    resolution: "resolved",
    resolutionReason: resolution.reason,
    confidence: resolution.confidence,
    activeProject: {
      ...resolution.project,
      ...details,
    },
    candidates: memory.projects,
  };
}

export function resolveActiveProject({
  memory,
  sourceText,
  conversation = [],
}: {
  memory: AssistantProjectMemory;
  sourceText: string;
  conversation?: AssistantConversationMessage[];
}) {
  const activeProjects = memory.projects.filter(
    (project) => project.status === "active",
  );
  const configured = activeProjects.find(
    (project) => project.id === memory.activeProjectId,
  );

  if (activeProjects.length === 1) {
    return {
      kind: "resolved" as const,
      project: activeProjects[0],
      confidence: configured ? 1 : 0.95,
      reason: configured
        ? "active_project_setting"
        : "single_active_project",
    };
  }

  if (!activeProjects.length) {
    return {
      kind: "none" as const,
      project: undefined,
      confidence: 0,
      reason: "no_active_projects",
    };
  }

  const contextText = normalizeText(
    [
      sourceText,
      ...conversation.slice(-12).map((message) => message.text),
    ].join("\n"),
  );
  const ranked = activeProjects
    .map((project) => ({
      project,
      score: scoreProject(project, contextText),
    }))
    .sort((left, right) => right.score - left.score);
  const first = ranked[0];
  const second = ranked[1];

  if (first.score >= 40 && first.score - second.score >= 15) {
    return {
      kind: "resolved" as const,
      project: first.project,
      confidence: Math.min(0.94, 0.7 + first.score / 500),
      reason: "conversation_and_resource_match",
    };
  }

  if (configured) {
    return {
      kind: "resolved" as const,
      project: configured,
      confidence: 0.9,
      reason: "active_project_setting",
    };
  }

  return {
    kind: "ambiguous" as const,
    project: undefined,
    confidence: 0,
    reason: "multiple_project_candidates",
  };
}

export function formatAssistantProjectContext(
  context: AssistantProjectContext | undefined,
) {
  if (!context) {
    return "";
  }

  const lines = [
    `Результат определения проекта: ${context.resolution}; confidence=${context.confidence.toFixed(2)}; reason=${context.resolutionReason}`,
    context.timezone ? `Часовой пояс пользователя: ${context.timezone}` : "",
    context.preferredResponseStyle
      ? `Предпочтительный стиль ответа: ${context.preferredResponseStyle}`
      : "",
  ];

  if (context.activeProject) {
    const project = context.activeProject;
    lines.push(
      `Активный проект: ${project.name} [project_id=${project.id}]`,
      project.goal ? `Цель: ${project.goal}` : "",
      project.stage ? `Стадия: ${project.stage}` : "",
      project.kpis.length ? `KPI: ${project.kpis.join("; ")}` : "",
      project.aliases.length
        ? `Алиасы проекта: ${project.aliases.join(", ")}`
        : "",
      ...formatResources(project.resources),
      ...project.glossary.map(
        (item) =>
          `Glossary: ${item.term} = ${item.definition}${item.aliases.length ? `; aliases=${item.aliases.join(", ")}` : ""}`,
      ),
      ...project.operatingRules.map(
        (rule) => `Правило [${rule.priority}/${rule.key}]: ${rule.text}`,
      ),
      ...project.decisions.map(
        (decision) =>
          `Последнее решение: ${decision.decision}${decision.rationale ? `; основание=${decision.rationale}` : ""}`,
      ),
      ...project.recentActions.map(
        (action) =>
          `Недавнее действие: ${action.actionType}; status=${action.status}`,
      ),
    );
  } else if (context.candidates.length) {
    lines.push(
      "Возможные проекты:",
      ...context.candidates.map(
        (project) =>
          `- ${project.name} [project_id=${project.id}]${project.aliases.length ? `; aliases=${project.aliases.join(", ")}` : ""}`,
      ),
    );
  }

  const result = lines.filter(Boolean).join("\n");
  return result.length <= 8_000
    ? result
    : `${result.slice(0, 8_000)}\n…project context сокращён`;
}

function scoreProject(
  project: AssistantProjectCandidate,
  normalizedContext: string,
) {
  let score = scoreName(project.name, normalizedContext, 120);

  for (const alias of project.aliases) {
    score += scoreName(alias, normalizedContext, 100);
  }

  for (const resource of project.resources) {
    score += scoreName(resource.title, normalizedContext, 45);
  }

  return score;
}

function scoreName(
  value: string,
  normalizedContext: string,
  exactScore: number,
) {
  const normalized = normalizeText(value);

  if (normalized.length >= 3 && normalizedContext.includes(normalized)) {
    return exactScore;
  }

  const tokens = normalized
    .split(" ")
    .filter((token) => token.length >= 4)
    .map((token) => token.slice(0, Math.min(6, token.length)));

  return tokens.reduce(
    (score, token) =>
      score + (normalizedContext.includes(token) ? 12 : 0),
    0,
  );
}

function formatResources(resources: AssistantProjectResource[]) {
  return resources.map(
    (resource) =>
      `Связанный ресурс: ${resource.resourceType}; ${resource.title}; external_id=${resource.externalId}`,
  );
}

function normalizeText(value: string) {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function emptyContext(
  telegramUserId: number,
  telegramChatId: number,
  reason: string,
): AssistantProjectContext {
  return {
    telegramUserId,
    telegramChatId,
    resolution: "none",
    resolutionReason: reason,
    confidence: 0,
    candidates: [],
  };
}

export { EMPTY_DETAILS };
