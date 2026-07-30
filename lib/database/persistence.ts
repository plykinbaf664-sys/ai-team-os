import {
  createSupabaseRestClientFromEnv,
  type SupabaseRestClient,
} from "./supabase-rest";
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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error";
}
