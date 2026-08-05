import type { AgentRunRequest, ResearchArtifact } from "../project/types";
import { researchAgentSystemPrompt } from "../prompts/research-agent";
import {
  createOpenAIResearchAdapterFromEnv,
  type ResearchAdapter,
  type ResearchAdapterOutput,
} from "../../integrations/research/openai-research-adapter";

export type ResearchTaskResult = ResearchAdapterOutput & {
  title: string;
  filename: string;
  verdict?: string;
};

export async function runResearchTask(
  {
    task,
    projectGoal,
    userName = "Пользователь",
  }: {
    task: string;
    projectGoal: string;
    userName?: string;
  },
  adapterOverride?: ResearchAdapter | null,
): Promise<ResearchTaskResult> {
  const adapter =
    adapterOverride === undefined
      ? createOpenAIResearchAdapterFromEnv()
      : adapterOverride;
  if (!adapter) {
    throw new Error("Research integration is not configured.");
  }
  const output = await adapter.run({
    systemPrompt: buildResearchSystemPrompt(),
    userPrompt: buildResearchPrompt({ task, projectGoal, userName }),
  });
  validateResearchOutput(output);
  const markdown = appendSources(output.markdown, output.sources);

  return {
    ...output,
    markdown,
    title: `Research: ${projectGoal.trim().slice(0, 120)}`,
    filename: buildFilename(projectGoal),
    ...(extractVerdict(markdown) ? { verdict: extractVerdict(markdown) } : {}),
  };
}

export async function runResearchAgent(
  request: AgentRunRequest,
  artifactId: string,
  createdAt: string,
  adapterOverride?: ResearchAdapter | null,
): Promise<ResearchArtifact> {
  assertRequest(request);
  const research = await runResearchTask(
    {
      task: request.payload.task,
      projectGoal: request.payload.projectGoal,
      userName: "Project Agent",
    },
    adapterOverride,
  );

  return {
    id: artifactId,
    traceId: request.traceId,
    runId: request.runId,
    agentRole: "research",
    type: "research_summary",
    title: research.title,
    content: {
      markdown: research.markdown,
      filename: research.filename,
      sources: research.sources,
      provider: research.provider,
      model: research.model,
      ...(research.verdict ? { verdict: research.verdict } : {}),
    },
    createdAt,
  };
}

function assertRequest(request: AgentRunRequest) {
  if (request.requestedBy !== "project") {
    throw new Error("Research Agent can only be started by Project Agent.");
  }
  if (request.targetAgent !== "research") {
    throw new Error("Research Agent received an unsupported target.");
  }
  if (request.depth !== 1) {
    throw new Error("Research Agent must run at depth 1.");
  }
}

function validateResearchOutput(output: ResearchAdapterOutput) {
  if (output.markdown.trim().length < 200) {
    throw new Error("Research artifact is too short to be accepted.");
  }
  if (!output.sources.length) {
    throw new Error("Research artifact has no verifiable sources.");
  }
  if (!/^#{1,3}\s+/mu.test(output.markdown)) {
    throw new Error("Research artifact has no report structure.");
  }
}

function buildResearchSystemPrompt() {
  return [
    researchAgentSystemPrompt,
    "",
    "Работай как senior marketing researcher, market analyst и competitive intelligence expert.",
    "Используй web search и актуальные интернет-источники. Не опирайся только на общие знания.",
    "Верни профессиональный Markdown-отчёт на русском языке с видимыми URL и ссылками на источники.",
    "Приоритет источников: сайты и страницы продуктов конкурентов, цены, checkout, соцсети, вебинары, рекламные библиотеки, официальная статистика и исследования рынка.",
    "Не придумывай цену, выручку, воронку, продукт или спрос. Если данных нет, явно напиши: не найдено в доступных источниках.",
    "Каждый вывод привязывай к наблюдению, факту, источнику или явно обозначенной гипотезе.",
    "Раздел конкурентов делай плотной сравнительной таблицей.",
    "Обязательная структура:",
    "# Research Report: <ниша>",
    "## 1. Исходные данные",
    "## 2. Срез рынка",
    "## 3. Деньги в нише",
    "## 4. Анализ конкурентов",
    "## 5. Сравнительная таблица",
    "## 6. Дыры рынка",
    "## 7. Возможное позиционирование",
    "## 8. Рекомендация по входу в нишу",
    "## 9. Итоговый вывод как маркетолог",
    "## 10. Источники",
    "В финале дай оценки 1–10: потенциал, конкуренция, сложность входа, денежность и шанс запуска; затем лучший угол входа, главный риск, главную возможность и первый шаг.",
    "Вердикт должен быть однозначным: запускать сейчас, сначала тестировать, сузить нишу или отказаться.",
  ].join("\n");
}

function buildResearchPrompt({
  task,
  projectGoal,
  userName,
}: {
  task: string;
  projectGoal: string;
  userName: string;
}) {
  return [
    `Заказчик: ${userName}`,
    `Цель проекта: ${projectGoal}`,
    "Задача исследования:",
    task,
    "",
    "Не теряй исходную нишу при обработке дополнительных критериев.",
    "Определи, жив ли рынок, есть ли в нём деньги, насколько сильны спрос и конкуренция, кто уже продаёт и за счёт чего, где есть свободное позиционирование.",
    "Для каждого конкурента найди URL, ЦА, продуктовую линейку, обещание, цены при наличии, вход в воронку, доказательства, сильные и слабые стороны.",
    "Заверши конкретным вердиктом и планом первого рыночного теста.",
  ].join("\n");
}

function appendSources(
  markdown: string,
  sources: Array<{ url: string; title?: string }>,
) {
  if (/^##\s+(?:10\.\s*)?(?:Источники|Sources)/imu.test(markdown)) {
    return markdown.trim();
  }
  return [
    markdown.trim(),
    "",
    "## 10. Источники",
    ...sources.map(
      (source, index) =>
        `${index + 1}. [${source.title || source.url}](${source.url})`,
    ),
  ].join("\n");
}

function extractVerdict(markdown: string) {
  const lines = markdown
    .split("\n")
    .map((line) => line.replace(/^[-*#\s]+/u, "").trim())
    .filter(Boolean);
  return lines.find((line) =>
    /^(?:вердикт|рекомендация|решение)\s*[:—-]/iu.test(line),
  )?.slice(0, 500);
}

function buildFilename(goal: string) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = goal
    .toLocaleLowerCase("ru")
    .replace(/[^a-zа-яё0-9]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "research";
  return `research-report-${date}-${slug}.md`;
}
