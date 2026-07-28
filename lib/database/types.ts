export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type PersistenceAgentRun = {
  id: string;
  traceId: string;
  parentRunId?: string;
  role: string;
  status:
    | "running"
    | "completed"
    | "failed"
    | "needs_clarification"
    | "needs_confirmation";
  depth: number;
  payload: JsonObject;
  output?: JsonObject;
};

export type PersistenceAction = {
  externalActionId: string;
  actionType: string;
  payload: JsonObject;
  status:
    | "planned"
    | "needs_clarification"
    | "needs_confirmation"
    | "ready"
    | "completed"
    | "failed";
  result?: {
    status:
      | "succeeded"
      | "failed"
      | "needs_clarification"
      | "needs_confirmation";
    message: string;
    errorCode?: string;
  };
};

export type PersistenceConfirmation = {
  prompt: string;
  reason: string;
  operationSummary: string;
};

export type PersistenceArtifact = {
  id: string;
  traceId: string;
  runId: string;
  type: string;
  title: string;
  content: JsonObject;
  createdAt: string;
};

export type AgentPersistenceEnvelope = {
  traceId: string;
  rootRunId: string;
  runs: PersistenceAgentRun[];
  actions: PersistenceAction[];
  confirmations: PersistenceConfirmation[];
  artifacts: PersistenceArtifact[];
};

export type TelegramPersistenceContext = {
  updateId: number;
  chatId: number;
  messageId: number;
  userId: number;
  username?: string;
  firstName?: string;
  text: string;
};

export type VoiceTranscriptPersistenceInput = {
  context: TelegramPersistenceContext;
  fileId: string;
  durationSeconds: number;
  status: "pending" | "processing" | "completed" | "failed";
  transcript?: string;
  language?: string;
  errorMessage?: string;
};
