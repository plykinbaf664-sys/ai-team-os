import {
  createSupabaseRestClientFromEnv,
  type SupabaseRestClient,
} from "./supabase-rest";
import type {
  AssistantProjectDetails,
  AssistantProjectMemory,
  AssistantProjectResource,
} from "../agents/assistant/project-context";
import type {
  AgentPersistenceEnvelope,
  JsonObject,
  TelegramPersistenceContext,
  VoiceTranscriptPersistenceInput,
} from "./types";

export type TelegramUpdateClaim = "claimed" | "duplicate";

export type RecentAssistantMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
};

export type TelegramReplyContext = {
  role: "assistant" | "project";
  text: string;
};

export type Persistence = {
  getAssistantProjectMemory(
    telegramUserId: number,
  ): Promise<AssistantProjectMemory>;
  getAssistantProjectDetails(
    projectId: string,
  ): Promise<AssistantProjectDetails>;
  claimTelegramUpdate(
    context: TelegramPersistenceContext,
  ): Promise<TelegramUpdateClaim>;
  recordIgnoredUpdate(
    context: TelegramPersistenceContext,
    reason: string,
  ): Promise<void>;
  recordAgentInteraction(input: {
    context: TelegramPersistenceContext;
    role: "assistant" | "project";
    responseText: string;
    envelope: AgentPersistenceEnvelope;
  }): Promise<void>;
  completeTelegramUpdate(updateId: number, traceId: string): Promise<void>;
  failTelegramUpdate(updateId: number, error: unknown): Promise<void>;
  saveVoiceTranscript(input: VoiceTranscriptPersistenceInput): Promise<void>;
  getRecentAssistantMessages(
    chatId: number,
    limit?: number,
  ): Promise<RecentAssistantMessage[]>;
  getTelegramReplyContext(
    chatId: number,
    messageId: number,
  ): Promise<TelegramReplyContext | null>;
  recordOutgoingTelegramMessage(
    updateId: number,
    messageId: number,
  ): Promise<void>;
};

export function createPersistenceFromEnv(): Persistence | null {
  const client = createSupabaseRestClientFromEnv();
  return client ? createPersistence(client) : null;
}

export function createPersistence(client: SupabaseRestClient): Persistence {
  return {
    async getAssistantProjectMemory(telegramUserId) {
      const userRows = await client.select("users", {
        columns: ["id"],
        equals: { telegram_user_id: telegramUserId },
        limit: 1,
      });
      const userId = optionalString(userRows[0]?.id);

      if (!userId) {
        return { projects: [] };
      }

      const [settingsRows, projectRows] = await Promise.all([
        client.select("user_settings", {
          columns: [
            "timezone",
            "active_project_id",
            "preferred_response_style",
          ],
          equals: { user_id: userId },
          limit: 1,
        }),
        client.select("team_projects", {
          columns: [
            "id",
            "name",
            "status",
            "metadata",
            "updated_at",
          ],
          equals: { owner_user_id: userId },
          orderBy: { column: "updated_at", ascending: false },
          limit: 30,
        }),
      ]);
      const projects = await Promise.all(
        projectRows.flatMap((row) => {
          const id = optionalString(row.id);
          const name = optionalString(row.name);

          if (!id || !name) {
            return [];
          }

          return [loadProjectCandidate(client, row, id, name)];
        }),
      );
      const settings = settingsRows[0];

      return {
        userId,
        timezone: optionalString(settings?.timezone),
        preferredResponseStyle: optionalString(
          settings?.preferred_response_style,
        ),
        activeProjectId: optionalString(settings?.active_project_id),
        projects,
      };
    },

    async getAssistantProjectDetails(projectId) {
      const [glossaryRows, ruleRows, decisionRows, actionRows] =
        await Promise.all([
          client.select("project_glossary", {
            columns: ["term", "definition", "aliases"],
            equals: { project_id: projectId, status: "active" },
            orderBy: { column: "updated_at", ascending: false },
            limit: 50,
          }),
          client.select("project_operating_rules", {
            columns: ["rule_key", "rule_text", "priority"],
            equals: { project_id: projectId, status: "active" },
            orderBy: { column: "priority", ascending: false },
            limit: 30,
          }),
          client.select("assistant_decisions", {
            columns: ["decision", "rationale", "created_at"],
            equals: { project_id: projectId, status: "active" },
            orderBy: { column: "created_at", ascending: false },
            limit: 12,
          }),
          client.select("action_requests", {
            columns: ["action_type", "status", "payload", "created_at"],
            equals: { project_id: projectId },
            orderBy: { column: "created_at", ascending: false },
            limit: 12,
          }),
        ]);

      return {
        glossary: glossaryRows.flatMap((row) => {
          const term = optionalString(row.term);
          const definition = optionalString(row.definition);
          return term && definition
            ? [
                {
                  term,
                  definition,
                  aliases: stringArray(row.aliases),
                },
              ]
            : [];
        }),
        operatingRules: ruleRows.flatMap((row) => {
          const key = optionalString(row.rule_key);
          const text = optionalString(row.rule_text);
          return key && text
            ? [
                {
                  key,
                  text,
                  priority:
                    typeof row.priority === "number" ? row.priority : 0,
                },
              ]
            : [];
        }),
        decisions: decisionRows.flatMap((row) => {
          const decision = optionalString(row.decision);
          return decision
            ? [
                {
                  decision,
                  rationale: optionalString(row.rationale),
                  createdAt: optionalString(row.created_at),
                },
              ]
            : [];
        }),
        recentActions: actionRows.flatMap((row) => {
          const actionType = optionalString(row.action_type);
          const status = optionalString(row.status);
          return actionType && status
            ? [
                {
                  actionType,
                  status,
                  payload: isJsonObject(row.payload) ? row.payload : {},
                  createdAt: optionalString(row.created_at),
                },
              ]
            : [];
        }),
      };
    },

    async getTelegramReplyContext(chatId, messageId) {
      const rows = await client.select("assistant_messages", {
        columns: ["agent_role", "text"],
        equals: {
          telegram_chat_id: chatId,
          telegram_message_id: messageId,
          direction: "outbound",
        },
        limit: 1,
      });
      const row = rows[0];

      if (
        (row?.agent_role !== "assistant" &&
          row?.agent_role !== "project") ||
        typeof row.text !== "string" ||
        !row.text.trim()
      ) {
        return null;
      }

      return {
        role: row.agent_role,
        text: row.text.trim().slice(0, 4_000),
      };
    },

    async recordOutgoingTelegramMessage(updateId, messageId) {
      const rows = await client.update(
        "assistant_messages",
        { telegram_message_id: messageId },
        {
          telegram_update_id: String(updateId),
          direction: "outbound",
        },
      );

      if (rows.length === 0) {
        throw new Error("Outbound Telegram message record was not found.");
      }
    },

    async getRecentAssistantMessages(chatId, limit = 12) {
      const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 30);
      const rows = await client.select("assistant_messages", {
        columns: ["direction", "text", "created_at"],
        equals: {
          telegram_chat_id: chatId,
          agent_role: "assistant",
        },
        orderBy: {
          column: "created_at",
          ascending: false,
        },
        limit: safeLimit,
      });

      return rows
        .flatMap((row): RecentAssistantMessage[] => {
          if (
            (row.direction !== "inbound" &&
              row.direction !== "outbound") ||
            typeof row.text !== "string" ||
            !row.text.trim()
          ) {
            return [];
          }

          return [
            {
              role: row.direction === "inbound" ? "user" : "assistant",
              text: row.text.trim().slice(0, 2_000),
              ...(typeof row.created_at === "string"
                ? { createdAt: row.created_at }
                : {}),
            },
          ];
        })
        .reverse();
    },

    async claimTelegramUpdate(context) {
      const result = await client.rpc("claim_telegram_update", {
        p_update_id: context.updateId,
        p_chat_id: context.chatId,
        p_user_id: context.userId,
      });

      if (result === "claimed" || result === "duplicate") {
        return result;
      }

      throw new Error("Supabase returned an invalid Telegram claim result.");
    },

    async recordIgnoredUpdate(context, reason) {
      const userId = await upsertUser(client, context);

      await upsertInboundMessage(client, {
        context,
        userId,
        role: null,
        traceId: null,
      });
      await client.update(
        "telegram_updates",
        {
          status: "ignored",
          ignored_reason: reason,
          completed_at: new Date().toISOString(),
        },
        { telegram_update_id: String(context.updateId) },
      );
      await upsertAuditLog(client, {
        traceId: null,
        context,
        eventType: "telegram_update_ignored",
        details: { reason },
      });
    },

    async recordAgentInteraction({
      context,
      role,
      responseText,
      envelope,
    }) {
      const userId = await upsertUser(client, context);
      const messageId = await upsertInboundMessage(client, {
        context,
        userId,
        role,
        traceId: envelope.traceId,
      });
      await upsertOutboundMessage(client, {
        context,
        userId,
        role,
        traceId: envelope.traceId,
        responseText,
      });

      for (const run of envelope.runs) {
        await client.upsert(
          "agent_runs",
          {
            id: run.id,
            trace_id: run.traceId,
            parent_run_id: run.parentRunId ?? null,
            message_id: messageId,
            agent_role: run.role,
            status: run.status,
            depth: run.depth,
            payload: run.payload,
            output: run.output ?? null,
            completed_at:
              run.status === "completed" || run.status === "failed"
                ? new Date().toISOString()
                : null,
          },
          { onConflict: "id" },
        );
      }

      for (const action of envelope.actions) {
        const idempotencyKey = `${envelope.traceId}:${action.externalActionId}`;
        const rows = await client.upsert(
          "action_requests",
          {
            external_action_id: action.externalActionId,
            trace_id: envelope.traceId,
            agent_run_id: envelope.rootRunId,
            message_id: messageId,
            action_type: action.actionType,
            project_id: action.projectId ?? null,
            payload: action.payload,
            status: action.status,
            idempotency_key: idempotencyKey,
          },
          { onConflict: "idempotency_key" },
        );
        const actionRequestId = requireString(rows[0]?.id, "action request id");

        if (action.result) {
          await client.upsert(
            "action_executions",
            {
              action_request_id: actionRequestId,
              status: action.result.status,
              result: { message: action.result.message },
              error_code: action.result.errorCode ?? null,
              idempotency_key: `${idempotencyKey}:execution`,
            },
            { onConflict: "idempotency_key" },
          );
        }
      }

      for (const [index, confirmation] of envelope.confirmations.entries()) {
        await client.upsert(
          "action_confirmations",
          {
            trace_id: envelope.traceId,
            action_request_id: null,
            status: "pending",
            prompt: confirmation.prompt,
            reason: confirmation.reason,
            operation_summary: confirmation.operationSummary,
            idempotency_key: `${envelope.traceId}:confirmation:${index}`,
          },
          { onConflict: "idempotency_key" },
        );
      }

      for (const artifact of envelope.artifacts) {
        await client.upsert(
          "artifacts",
          {
            id: artifact.id,
            trace_id: artifact.traceId,
            agent_run_id: artifact.runId,
            artifact_type: artifact.type,
            title: artifact.title,
            content: artifact.content,
            created_at: artifact.createdAt,
          },
          { onConflict: "id" },
        );
      }

      await upsertAuditLog(client, {
        traceId: envelope.traceId,
        context,
        eventType: "agent_interaction_recorded",
        details: {
          role,
          response_text: responseText,
          run_count: envelope.runs.length,
          action_count: envelope.actions.length,
          artifact_count: envelope.artifacts.length,
        },
      });
    },

    async completeTelegramUpdate(updateId, traceId) {
      await client.update(
        "telegram_updates",
        {
          status: "completed",
          trace_id: traceId,
          completed_at: new Date().toISOString(),
        },
        { telegram_update_id: String(updateId) },
      );
    },

    async failTelegramUpdate(updateId, error) {
      await client.update(
        "telegram_updates",
        {
          status: "failed",
          error_message: getErrorMessage(error),
        },
        { telegram_update_id: String(updateId) },
      );
    },

    async saveVoiceTranscript({
      context,
      fileId,
      durationSeconds,
      status,
      transcript,
      language,
      errorMessage,
    }) {
      await client.upsert(
        "voice_transcripts",
        {
          telegram_update_id: context.updateId,
          telegram_message_id: context.messageId,
          telegram_file_id: fileId,
          transcript: transcript ?? null,
          language: language ?? null,
          duration_seconds: durationSeconds,
          status,
          error_message: errorMessage ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "telegram_file_id,telegram_message_id" },
      );
    },
  };
}

async function upsertUser(
  client: SupabaseRestClient,
  context: TelegramPersistenceContext,
) {
  const rows = await client.upsert(
    "users",
    {
      telegram_user_id: context.userId,
      username: context.username ?? null,
      first_name: context.firstName ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "telegram_user_id" },
  );

  return requireString(rows[0]?.id, "user id");
}

async function upsertInboundMessage(
  client: SupabaseRestClient,
  input: {
    context: TelegramPersistenceContext;
    userId: string;
    role: "assistant" | "project" | null;
    traceId: string | null;
  },
) {
  const rows = await client.upsert(
    "assistant_messages",
    {
      telegram_update_id: input.context.updateId,
      user_id: input.userId,
      telegram_chat_id: input.context.chatId,
      telegram_message_id: input.context.messageId,
      direction: "inbound",
      agent_role: input.role,
      trace_id: input.traceId,
      text: input.context.text,
    },
    { onConflict: "telegram_update_id,direction" },
  );

  return requireString(rows[0]?.id, "message id");
}

async function upsertOutboundMessage(
  client: SupabaseRestClient,
  input: {
    context: TelegramPersistenceContext;
    userId: string;
    role: "assistant" | "project";
    traceId: string;
    responseText: string;
  },
) {
  await client.upsert(
    "assistant_messages",
    {
      telegram_update_id: input.context.updateId,
      user_id: input.userId,
      telegram_chat_id: input.context.chatId,
      telegram_message_id: input.context.messageId,
      direction: "outbound",
      agent_role: input.role,
      trace_id: input.traceId,
      text: input.responseText,
      metadata: {
        reply_to_telegram_message_id: input.context.messageId,
      },
    },
    { onConflict: "telegram_update_id,direction" },
  );
}

async function upsertAuditLog(
  client: SupabaseRestClient,
  input: {
    traceId: string | null;
    context: TelegramPersistenceContext;
    eventType: string;
    details: JsonObject;
  },
) {
  await client.upsert(
    "audit_logs",
    {
      trace_id: input.traceId,
      actor_type: "telegram_user",
      actor_id: String(input.context.userId),
      event_type: input.eventType,
      entity_type: "telegram_update",
      entity_id: String(input.context.updateId),
      details: input.details,
      idempotency_key: `${input.context.updateId}:${input.eventType}`,
    },
    { onConflict: "idempotency_key" },
  );
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Supabase response is missing ${field}.`);
  }

  return value;
}

async function loadProjectCandidate(
  client: SupabaseRestClient,
  row: JsonObject,
  id: string,
  name: string,
) {
  const resourceRows = await client.select("project_resources", {
    columns: [
      "id",
      "project_id",
      "resource_type",
      "external_id",
      "title",
      "metadata",
    ],
    equals: { project_id: id, status: "active" },
    orderBy: { column: "updated_at", ascending: false },
    limit: 30,
  });
  const metadata = isJsonObject(row.metadata) ? row.metadata : {};

  return {
    id,
    name,
    status: optionalString(row.status) ?? "active",
    goal: optionalString(metadata.goal),
    stage: optionalString(metadata.stage),
    kpis: metricList(metadata.kpis),
    aliases: stringArray(metadata.aliases),
    resources: resourceRows.flatMap(toProjectResource),
    updatedAt: optionalString(row.updated_at),
  };
}

function toProjectResource(row: JsonObject): AssistantProjectResource[] {
  const id = optionalString(row.id);
  const projectId = optionalString(row.project_id);
  const resourceType = optionalString(row.resource_type);
  const externalId = optionalString(row.external_id);
  const title = optionalString(row.title);

  if (
    !id ||
    !projectId ||
    (resourceType !== "google_sheet" &&
      resourceType !== "ticktick_project") ||
    !externalId ||
    !title
  ) {
    return [];
  }

  return [
    {
      id,
      projectId,
      resourceType,
      externalId,
      title,
      metadata: isJsonObject(row.metadata) ? row.metadata : {},
    },
  ];
}

function metricList(value: unknown) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
    );
  }

  if (isJsonObject(value)) {
    return Object.entries(value).map(
      ([name, target]) => `${name}: ${String(target)}`,
    );
  }

  return [];
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
      )
    : [];
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error";
}
