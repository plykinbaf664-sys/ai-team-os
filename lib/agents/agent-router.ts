import { agentRegistry, getAgent, type AgentRole } from "./agent-registry";
import { assertRootAgentCall } from "./loop-guard";
import {
  buildProjectAssistantPrompt,
  projectAssistantSystemPrompt,
} from "./prompts/project-assistant";

type RouteAgentMessageInput = {
  role: AgentRole;
  text: string;
  chatId: number;
  userName: string;
};

type RouteAgentMessageResult = {
  role: AgentRole;
  text: string;
};

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

export async function routeAgentMessage(
  input: RouteAgentMessageInput,
): Promise<RouteAgentMessageResult> {
  assertRootAgentCall(input.role);

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

  const prompt = buildProjectAssistantPrompt({
    userText: input.text,
    userName: input.userName,
  });

  return {
    role: "project",
    text: await generateProjectAssistantReply(prompt),
  };
}

async function generateProjectAssistantReply(prompt: string) {
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
          content: projectAssistantSystemPrompt,
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
