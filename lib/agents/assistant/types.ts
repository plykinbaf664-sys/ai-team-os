export type AssistantMode =
  | "quick_command"
  | "batch_report"
  | "create_structure"
  | "analytics"
  | "daily_summary";

export type AssistantConversationMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
};

export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type SheetCellValue = string | number | boolean | null;

export type TaskSourceEntity = {
  type: "google_sheet_row";
  spreadsheetId: string;
  spreadsheetTitle?: string;
  sheetName: string;
  rowNumber: number;
  entityId: string;
  entityLabel?: string;
};

type Action<TType extends string, TPayload> = {
  id: string;
  type: TType;
  payload: TPayload;
};

export type MetricInput = {
  name: string;
  value: number;
  period?: string;
};

export type AddMetricsAction = Action<
  "add_metrics",
  {
    projectId?: string;
    metrics: MetricInput[];
  }
>;

export type UpdateMetricsAction = Action<
  "update_metrics",
  {
    projectId?: string;
    metrics: MetricInput[];
  }
>;

export type UpdateProjectStatusAction = Action<
  "update_project_status",
  {
    projectId: string;
    status: string;
  }
>;

export type CreateTaskAction = Action<
  "create_task",
  {
    title: string;
    dueDateText?: string;
    priority?: TaskPriority;
    project?: string;
    sourceEntity?: TaskSourceEntity;
  }
>;

export type UpdateTaskAction = Action<
  "update_task",
  {
    taskId?: string;
    taskTitle?: string;
    changes: {
      title?: string;
      contentNote?: string;
      dueDateText?: string;
      priority?: TaskPriority;
      project?: string;
    };
  }
>;

export type CompleteTaskAction = Action<
  "complete_task",
  {
    taskId?: string;
    taskTitle?: string;
  }
>;

export type ListTasksAction = Action<
  "list_tasks",
  {
    project?: string;
    limit?: number;
  }
>;

export type CreateCalendarEventAction = Action<
  "create_calendar_event",
  {
    title: string;
    date: string;
    startTime: string;
    endTime?: string;
    timezone?: string;
  }
>;

export type UpdateCalendarEventAction = Action<
  "update_calendar_event",
  {
    eventId?: string;
    eventTitle?: string;
    changes: {
      title?: string;
      date?: string;
      startTime?: string;
      endTime?: string;
      timezone?: string;
    };
  }
>;

export type CreateSheetAction = Action<
  "create_sheet",
  {
    title: string;
    blueprintId?: string;
  }
>;

export type CreateSheetTabAction = Action<
  "create_sheet_tab",
  {
    spreadsheetId: string;
    title: string;
  }
>;

export type ExistingSheetTarget =
  | {
      kind: "id";
      spreadsheetId: string;
    }
  | {
      kind: "title";
      title: string;
    };

export type FindSheetAction = Action<
  "find_sheet",
  {
    title: string;
  }
>;

export type ReadSheetAction = Action<
  "read_sheet",
  {
    target: ExistingSheetTarget;
    range?: string;
  }
>;

export type UpdateSheetAction = Action<
  "update_sheet",
  {
    target: ExistingSheetTarget;
    range: string;
    operation: "append_rows" | "update_cells" | "clear_range";
    values?: SheetCellValue[][];
  }
>;

export type SheetBlueprintTab = {
  title: string;
  columns: string[];
};

export type CreateSheetBlueprintAction = Action<
  "create_sheet_blueprint",
  {
    purpose: string;
    tabs: SheetBlueprintTab[];
  }
>;

export type AnalyzeMetricsAction = Action<
  "analyze_metrics",
  {
    projectId?: string;
    metricNames?: string[];
    period?: string;
  }
>;

export type GenerateDailySummaryAction = Action<
  "generate_daily_summary",
  {
    date?: string;
    timezone?: string;
  }
>;

export type AssistantAction =
  | AddMetricsAction
  | UpdateMetricsAction
  | UpdateProjectStatusAction
  | CreateTaskAction
  | UpdateTaskAction
  | CompleteTaskAction
  | ListTasksAction
  | CreateCalendarEventAction
  | UpdateCalendarEventAction
  | CreateSheetAction
  | CreateSheetTabAction
  | FindSheetAction
  | ReadSheetAction
  | UpdateSheetAction
  | CreateSheetBlueprintAction
  | AnalyzeMetricsAction
  | GenerateDailySummaryAction;

export type StrategicFact = {
  key: string;
  value: string | number | boolean;
  source: "message" | "project_context" | "resource_context" | "history";
  evidence: string;
};

export type StrategicAssumption = {
  text: string;
  evidence: string;
  confidence: number;
};

export type StrategicTargetResource = {
  type: "google_sheet" | "ticktick_project" | "calendar" | "other";
  externalId?: string;
  title?: string;
  sheetName?: string;
  entityId?: string;
  entityLabel?: string;
  rowNumber?: number;
};

export type StrategicExecutionPolicy =
  | "auto_execute"
  | "suggest_first"
  | "confirm_first";

export type StrategicActionKind =
  | "execute_action"
  | "recalculate_metrics"
  | "audit_log"
  | "verify_result";

export type StrategicAction = {
  id: string;
  kind: StrategicActionKind;
  linkedActionId?: string;
  actionType?: AssistantAction["type"];
  reason: string;
  evidence: string[];
  confidence: number;
  executionPolicy: StrategicExecutionPolicy;
  expectedChange: string;
  verification: string;
};

export type SuggestedAction = {
  id: string;
  title: string;
  reason: string;
  evidence: string[];
  confidence: number;
  proposedTask?: {
    title: string;
    dueDateText?: string;
    priority?: TaskPriority;
    project?: string;
    sourceEntity?: TaskSourceEntity;
  };
};

export type StrategicActionPlan = {
  version: 1;
  userGoal: string;
  projectId: string | null;
  targetResources: StrategicTargetResource[];
  factsFromMessage: StrategicFact[];
  factsFromContext: StrategicFact[];
  assumptions: StrategicAssumption[];
  actions: StrategicAction[];
  suggestions: SuggestedAction[];
  clarification?: {
    question: string;
    missingField: string;
  };
  summaryIntent: string;
};

export type ActionRiskLevel = "read" | "safe_write" | "sensitive_write" | "critical";

export type ActionConfidenceDecision =
  | "execute"
  | "clarify"
  | "confirm";

export type ActionConfidenceAssessment = {
  actionId: string;
  risk: ActionRiskLevel;
  confidence: number;
  threshold: number;
  decision: ActionConfidenceDecision;
  evidence: string[];
  question?: string;
};

export type ActionPlanPolicyEvaluation = {
  assessments: ActionConfidenceAssessment[];
  executableActionIds: string[];
  blockedActionIds: string[];
  clarificationQuestions: string[];
};

export type ProactiveFindingKind =
  | "stale_segment"
  | "missed_follow_up"
  | "plan_fact_deviation"
  | "missing_next_action"
  | "inconsistent_data";

export type ProactiveFinding = {
  id: string;
  kind: ProactiveFindingKind;
  severity: "low" | "medium" | "high";
  title: string;
  recommendation: string;
  evidence: string[];
  spreadsheetId: string;
  sheetName: string;
  rowNumber: number;
  entityId: string;
  entityLabel: string;
};

export type ProactiveMonitoringReport = {
  version: 1;
  checkedAt: string;
  scope: "relevant_context";
  findings: ProactiveFinding[];
};

export type ActionPlan = {
  version: 1;
  mode: AssistantMode;
  sourceText: string;
  actions: AssistantAction[];
  continueAfterReads?: boolean;
  strategicPlan?: StrategicActionPlan;
  monitoringReport?: ProactiveMonitoringReport;
};

export type ActionResult = {
  actionId: string;
  actionType: AssistantAction["type"];
  status:
    | "succeeded"
    | "failed"
    | "needs_clarification"
    | "needs_confirmation";
  message: string;
  errorCode?: string;
  data?: AssistantToolResultData;
};

export type AssistantToolResultData =
  | {
      kind: "ticktick_tasks";
      tasks: Array<{
        id: string;
        projectId: string;
        projectName: string;
        title: string;
        content?: string;
        dueDate?: string;
        timeZone?: string;
        priority: number;
      }>;
    }
  | {
      kind: "sheet_range";
      spreadsheetId: string;
      spreadsheetTitle: string;
      range: string;
      values: SheetCellValue[][];
    };

export type ClarificationRequest = {
  kind: "clarification";
  question: string;
  missingField: string;
};

export type ConfirmationRequest = {
  kind: "confirmation";
  prompt: string;
  reason: string;
  operationSummary: string;
};

export type AssistantDirectResponse = {
  kind: "response";
  text: string;
};

export type AssistantPlanOutcome =
  | {
      kind: "ready";
      plan: ActionPlan;
    }
  | ClarificationRequest
  | ConfirmationRequest
  | AssistantDirectResponse;
