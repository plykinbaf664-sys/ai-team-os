export type AssistantMode =
  | "quick_command"
  | "batch_report"
  | "create_structure"
  | "analytics"
  | "daily_summary";

export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type SheetCellValue = string | number | boolean | null;

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
  }
>;

export type UpdateTaskAction = Action<
  "update_task",
  {
    taskId?: string;
    taskTitle?: string;
    changes: {
      title?: string;
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

export type UpdateSheetAction = Action<
  "update_sheet",
  {
    spreadsheetId: string;
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
  | CreateCalendarEventAction
  | UpdateCalendarEventAction
  | CreateSheetAction
  | CreateSheetTabAction
  | UpdateSheetAction
  | CreateSheetBlueprintAction
  | AnalyzeMetricsAction
  | GenerateDailySummaryAction;

export type ActionPlan = {
  version: 1;
  mode: AssistantMode;
  sourceText: string;
  actions: AssistantAction[];
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

export type AssistantPlanOutcome =
  | {
      kind: "ready";
      plan: ActionPlan;
    }
  | ClarificationRequest
  | ConfirmationRequest;
