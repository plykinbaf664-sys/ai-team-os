import type {
  ActionResult,
  AssistantAction,
  AssistantConversationMessage,
  AssistantPlanOutcome,
} from "./types";

const CONTINUATION_PATTERN =
  /^(?:ты\s+)?(?:сам\s+)?(?:это\s+)?(?:можешь(?:\s+это)?(?:\s+сделать)?|сделаешь|сделай|делай|выполни|поправь)(?:\s+(?:сам|сама|это))?[\s.!?]*$/iu;
const OPERATIONAL_PATTERN =
  /свер|синхрониз|привед\w*\s+(?:в\s+)?(?:поряд|актуальн)|подчист|почист|поправ|актуализ|скоррект|обнов|измен|добав|помет|внес|запиш|зафиксир|заверш|удал|очист|сам\s+(?:сдел|выполн)/iu;
const TASK_STOP_WORDS = new Set([
  "задача",
  "задачи",
  "задачу",
  "получить",
  "сделать",
  "проверить",
  "добавить",
  "довести",
  "определить",
  "назначить",
  "отправить",
  "написать",
  "согласовать",
  "проект",
  "приоритет",
  "созвон",
  "одно",
  "один",
  "первый",
  "следующий",
]);

type TickTickTask = Extract<
  NonNullable<ActionResult["data"]>,
  { kind: "ticktick_tasks" }
>["tasks"][number];

type SheetObservation = Extract<
  NonNullable<ActionResult["data"]>,
  { kind: "sheet_range" }
>;

export function hasOperationalMutationIntent(sourceText: string) {
  return OPERATIONAL_PATTERN.test(sourceText);
}

export function resolveOperationalContinuation(
  sourceText: string,
  conversation: AssistantConversationMessage[],
) {
  if (!CONTINUATION_PATTERN.test(sourceText.trim())) return sourceText;

  const previousRequest = [...conversation]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        hasOperationalMutationIntent(message.text) &&
        message.text.trim().length > sourceText.trim().length,
    );

  if (!previousRequest) return sourceText;
  return `${previousRequest.text.trim()}\nУточнение пользователя: выполни это самостоятельно, а не только предложи.`;
}

export function reconcileOperationalActions(
  outcome: AssistantPlanOutcome,
  {
    sourceText,
    conversation,
    discoveryResults,
  }: {
    sourceText: string;
    conversation: AssistantConversationMessage[];
    discoveryResults: ActionResult[];
  },
): AssistantPlanOutcome {
  if (outcome.kind !== "ready" || !hasOperationalMutationIntent(sourceText)) {
    return outcome;
  }

  const tasks = collectTasks(discoveryResults);
  const sheets = collectSheets(discoveryResults);
  if (!tasks.length && !sheets.length) return outcome;

  const rejected: string[] = [];
  const groundedIds = new Set<string>();
  const actions = outcome.plan.actions.flatMap((action): AssistantAction[] => {
    if (action.type === "update_task" || action.type === "complete_task") {
      const grounded = groundTaskAction(action, tasks, sheets, sourceText, conversation);
      if (!grounded) {
        rejected.push("изменение TickTick без однозначно найденной задачи");
        return [];
      }
      groundedIds.add(action.id);
      return [grounded];
    }

    if (action.type === "update_sheet") {
      const grounded = groundSheetAction(action, sheets);
      if (!grounded) {
        rejected.push("изменение Google Sheets вне прочитанной строки");
        return [];
      }
      groundedIds.add(action.id);
      return [grounded];
    }

    return [action];
  });

  const groundedStrategicPlan = outcome.plan.strategicPlan
    ? {
        ...outcome.plan.strategicPlan,
        actions: outcome.plan.strategicPlan.actions.map((action) =>
          action.linkedActionId && groundedIds.has(action.linkedActionId)
            ? {
                ...action,
                confidence: Math.max(action.confidence, 0.92),
                executionPolicy:
                  action.executionPolicy === "confirm_first"
                    ? "confirm_first" as const
                    : "auto_execute" as const,
                evidence: [
                  ...action.evidence,
                  "Точный внешний объект подтверждён результатом чтения.",
                ],
              }
            : action,
        ),
      }
    : undefined;

  if (!rejected.length) {
    return {
      ...outcome,
      plan: {
        ...outcome.plan,
        actions,
        strategicPlan: groundedStrategicPlan,
      },
    };
  }

  if (!actions.length) {
    return {
      kind: "clarification",
      question:
        "Я прочитал данные, но не нашёл однозначной связи между изменением, конкретной задачей и строкой таблицы. Уточни только объект, который нужно изменить.",
      missingField: "operational_target",
    };
  }

  const retainedIds = new Set(actions.map((action) => action.id));
  const strategicPlan = groundedStrategicPlan
    ? {
        ...groundedStrategicPlan,
        actions: groundedStrategicPlan.actions.filter(
          (action) => !action.linkedActionId || retainedIds.has(action.linkedActionId),
        ),
        clarification: {
          question:
            "Однозначную часть выполнил. Для оставшейся части уточни конкретную задачу или строку.",
          missingField: "operational_target",
        },
      }
    : undefined;

  return {
    ...outcome,
    plan: { ...outcome.plan, actions, strategicPlan },
  };
}

function collectTasks(results: ActionResult[]) {
  const byId = new Map<string, TickTickTask>();
  for (const result of results) {
    if (result.status !== "succeeded" || result.data?.kind !== "ticktick_tasks") {
      continue;
    }
    for (const task of result.data.tasks) byId.set(task.id, task);
  }
  return [...byId.values()];
}

function collectSheets(results: ActionResult[]) {
  return results.flatMap((result): SheetObservation[] =>
    result.status === "succeeded" && result.data?.kind === "sheet_range"
      ? [result.data]
      : [],
  );
}

function groundTaskAction(
  action: Extract<AssistantAction, { type: "update_task" | "complete_task" }>,
  tasks: TickTickTask[],
  sheets: SheetObservation[],
  sourceText: string,
  conversation: AssistantConversationMessage[],
): Extract<AssistantAction, { type: "update_task" | "complete_task" }> | null {
  const task = resolveTask(action, tasks, sourceText, conversation);
  if (!task || !isTaskSupported(task, sheets, sourceText, conversation)) {
    return null;
  }

  if (
    action.type === "update_task" &&
    action.payload.changes.contentNote &&
    /(?:задач\w*\s+)?(?:удален|удалена|удалены|очищен|очищена|синхронизирован|синхронизированы)(?:\s|[.,;:]|$)/iu.test(
      action.payload.changes.contentNote,
    )
  ) {
    return null;
  }

  if (action.type === "update_task") {
    const changes = { ...action.payload.changes };
    if (changes.project && !requestsTaskMove(sourceText)) {
      delete changes.project;
    }
    if (!Object.keys(changes).length) return null;

    return {
      ...action,
      payload: {
        ...action.payload,
        taskId: task.id,
        taskTitle: task.title,
        changes,
      },
    };
  }

  return {
    ...action,
    payload: {
      ...action.payload,
      taskId: task.id,
      taskTitle: task.title,
    },
  };
}

function resolveTask(
  action: Extract<AssistantAction, { type: "update_task" | "complete_task" }>,
  tasks: TickTickTask[],
  sourceText: string,
  conversation: AssistantConversationMessage[],
) {
  if (action.payload.taskId) {
    return tasks.find((task) => task.id === action.payload.taskId);
  }
  if (!action.payload.taskTitle) return undefined;

  const requested = normalize(action.payload.taskTitle);
  const exact = tasks.filter((task) => normalize(task.title) === requested);
  if (exact.length === 1) return exact[0];

  const partial = tasks.filter((task) => {
    const title = normalize(task.title);
    return title.includes(requested) || requested.includes(title);
  });
  if (partial.length === 1) return partial[0];
  if (partial.length < 2) return undefined;

  const context = [
    sourceText,
    action.type === "update_task" ? action.payload.changes.contentNote : "",
    ...conversation
      .slice(-12)
      .filter((message) => message.role === "user")
      .map((message) => message.text),
  ].join(" ");
  const ranked = partial
    .map((task) => ({ task, score: taskContextScore(task, context) }))
    .sort((left, right) => right.score - left.score);
  const secondScore = ranked[1]?.score ?? 0;
  return ranked[0].score >= 2 && ranked[0].score > secondScore
    ? ranked[0].task
    : undefined;
}

function taskContextScore(task: TickTickTask, context: string) {
  const contextTokens = contextualTokens(context);
  const taskTokens = contextualTokens(
    [task.title, task.content, task.projectName].filter(Boolean).join(" "),
  );
  return contextTokens.reduce(
    (score, token) =>
      score +
      (taskTokens.some(
        (candidate) =>
          candidate === token ||
          (candidate.length >= 5 &&
            token.length >= 5 &&
            candidate.slice(0, 5) === token.slice(0, 5)),
      )
        ? 1
        : 0),
    0,
  );
}

function contextualTokens(value: string) {
  return [...new Set(
    normalize(value)
      .split(" ")
      .filter(
        (token) =>
          token.length >= 4 &&
          !/^\d+$/u.test(token) &&
          !TASK_STOP_WORDS.has(token) &&
          !/^(?:котор|нужно|карточ|тиктик|сейчас|только|данн|добав|помет|обнов|задач|уточн)/u.test(token),
      ),
  )];
}

function requestsTaskMove(sourceText: string) {
  return /(?:перенес|перемест|перелож|перевед|смест)[^.?!]{0,100}(?:проект|список)|(?:смен|измен)[^.?!]{0,60}(?:проект|список)|(?:проект|список)[^.?!]{0,60}(?:смен|измен)/iu.test(
    sourceText,
  );
}

function isTaskSupported(
  task: TickTickTask,
  sheets: SheetObservation[],
  sourceText: string,
  conversation: AssistantConversationMessage[],
) {
  const userContext = [
    sourceText,
    ...conversation
      .slice(-12)
      .filter((message) => message.role === "user")
      .map((message) => message.text),
  ].join("\n");
  const sheetContext = sheets
    .flatMap((sheet) => sheet.values.flat())
    .map((value) => String(value ?? ""))
    .join("\n");
  const context = normalize(`${userContext}\n${sheetContext}`);

  if (context.includes(normalize(task.id)) || context.includes(normalize(task.title))) {
    return true;
  }
  if (hasLinkedSheetMarker(task.content, sheets)) return true;

  const keywords = meaningfulTaskTokens(task.title);
  const contextTokens = new Set(context.split(" ").filter(Boolean));
  if (
    keywords.some(
      (token) =>
        context.includes(token) ||
        [...contextTokens].some(
          (candidate) =>
            candidate.length >= 5 &&
            token.length >= 5 &&
            candidate.slice(0, 5) === token.slice(0, 5),
        ),
    )
  ) {
    return true;
  }

  return Boolean(
    task.dueDate &&
      /просроч/iu.test(userContext) &&
      new Date(task.dueDate).getTime() < Date.now(),
  );
}

function meaningfulTaskTokens(title: string) {
  return normalize(title)
    .split(" ")
    .filter(
      (token) =>
        token.length >= 4 &&
        !/^\d+$/u.test(token) &&
        !TASK_STOP_WORDS.has(token),
    );
}

function hasLinkedSheetMarker(content: string | undefined, sheets: SheetObservation[]) {
  if (!content?.includes("ai-team-os:google-sheet-row:")) return false;
  return sheets.some((sheet) => content.includes(encodeURIComponent(sheet.spreadsheetId)));
}

function groundSheetAction(
  action: Extract<AssistantAction, { type: "update_sheet" }>,
  sheets: SheetObservation[],
): AssistantAction | null {
  const targetId = resolveSpreadsheetId(action, sheets);
  if (!targetId) return null;
  const writeRange = parseRange(action.payload.range);
  if (!writeRange) return null;

  const supportingRead = sheets.find((sheet) => {
    if (sheet.spreadsheetId !== targetId) return false;
    const readRange = parseRange(sheet.range);
    if (!readRange || normalize(readRange.sheet) !== normalize(writeRange.sheet)) {
      return false;
    }
    if (writeRange.row === undefined) return action.payload.operation === "append_rows";
    return (
      readRange.startRow !== undefined &&
      readRange.endRow !== undefined &&
      writeRange.row >= readRange.startRow &&
      writeRange.row <= readRange.endRow
    );
  });
  if (!supportingRead) return null;

  return {
    ...action,
    payload: {
      ...action.payload,
      target: { kind: "id", spreadsheetId: targetId },
    },
  };
}

function resolveSpreadsheetId(
  action: Extract<AssistantAction, { type: "update_sheet" }>,
  sheets: SheetObservation[],
) {
  const target = action.payload.target;
  if (target.kind === "id") {
    return sheets.some(
      (sheet) => sheet.spreadsheetId === target.spreadsheetId,
    )
      ? target.spreadsheetId
      : undefined;
  }

  const matches = sheets.filter(
    (sheet) => normalize(sheet.spreadsheetTitle) === normalize(target.title),
  );
  return matches.length === 1 ? matches[0].spreadsheetId : undefined;
}

function parseRange(range: string) {
  const match = range.match(/^'?([^']+?)'?!(?:[A-Z]+)(\d+)?(?::[A-Z]+(\d+)?)?$/iu);
  if (!match) return undefined;
  const startRow = match[2] ? Number(match[2]) : undefined;
  const endRow = match[3] ? Number(match[3]) : startRow;
  return {
    sheet: match[1].replace(/''/g, "'"),
    row: startRow,
    startRow,
    endRow,
  };
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
