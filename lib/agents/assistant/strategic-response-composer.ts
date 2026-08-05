import type {
  ActionPlan,
  ActionResult,
  AssistantAction,
  StrategicTargetResource,
} from "./types";

const READ_ACTIONS = new Set<AssistantAction["type"]>([
  "find_sheet",
  "read_sheet",
  "list_tasks",
  "analyze_metrics",
  "generate_daily_summary",
]);

export function composeStrategicResponse(
  plan: ActionPlan,
  results: ActionResult[],
  policyQuestions: string[] = [],
) {
  const dailySummary = results.find(
    (result) =>
      result.actionType === "generate_daily_summary" &&
      result.status === "succeeded",
  );
  if (
    dailySummary &&
    results.length === 1 &&
    policyQuestions.length === 0
  ) {
    return dailySummary.message;
  }
  const succeeded = results.filter((result) => result.status === "succeeded");
  const failed = results.filter((result) => result.status === "failed");
  const needsClarification = results.filter(
    (result) => result.status === "needs_clarification",
  );
  const needsConfirmation = results.filter(
    (result) => result.status === "needs_confirmation",
  );
  const sections: string[] = [];
  const numberChanges = unique(
    succeeded.flatMap((result) => extractNumberChanges(result.message)),
  );
  const completedLines = succeeded.map((result) =>
    formatCompletedResult(plan, result, numberChanges.length > 0),
  );

  if (completedLines.length) {
    const readOnly = succeeded.every((result) => READ_ACTIONS.has(result.actionType));
    sections.push(section(readOnly ? "Результат" : "Выполнено", completedLines));
  }
  if (numberChanges.length) {
    sections.push(section("Ключевые цифры", numberChanges));
  }
  if (failed.length) {
    sections.push(
      section(
        "Не выполнено",
        failed.map((result) => friendlyResultMessage(result)),
      ),
    );
  }

  const monitoringFindings = plan.monitoringReport?.findings ?? [];
  if (monitoringFindings.length) {
    sections.push(
      section(
        "Требует внимания",
        monitoringFindings.map((finding) => ensurePeriod(finding.title)),
      ),
    );
  }

  const conclusion = buildConclusion(plan, results);
  if (conclusion) {
    sections.push(section("Вывод", [conclusion]));
  }

  const suggestions = unique([
    ...(plan.strategicPlan?.suggestions ?? [])
      .filter(
        (suggestion) =>
          suggestion.confidence >= 0.6 && suggestion.evidence.length > 0,
      )
      .map(formatSuggestion),
    ...monitoringFindings.map((finding) =>
      ensurePeriod(finding.recommendation),
    ),
  ]);
  if (suggestions.length) {
    sections.push(section("Рекомендация", suggestions));
  }

  const confirmationPrompts = unique([
    ...needsConfirmation
      .filter((result) => result.errorCode !== "confidence_confirmation_required")
      .map((result) => friendlyResultMessage(result)),
    ...policyQuestions
      .filter(isConfirmationQuestion)
      .map((question) => friendlyPolicyQuestion(question, plan)),
  ]);
  if (confirmationPrompts.length) {
    sections.push(section("Нужно подтверждение", confirmationPrompts));
  }

  const clarificationPrompts = unique([
    ...needsClarification
      .filter((result) => result.errorCode !== "confidence_too_low")
      .map((result) => friendlyResultMessage(result)),
    ...policyQuestions
      .filter((question) => !isConfirmationQuestion(question))
      .map((question) => friendlyPolicyQuestion(question, plan)),
  ]);
  if (clarificationPrompts.length) {
    sections.push(section("Нужно уточнить", clarificationPrompts));
  }

  return sections.join("\n\n") || "Не удалось получить результат.";
}

function formatCompletedResult(
  plan: ActionPlan,
  result: ActionResult,
  hasNumberChanges: boolean,
) {
  if (result.actionType === "update_sheet" && hasNumberChanges) {
    const resource = findTargetResource(plan, result);
    if (resource?.sheetName && resource.rowNumber) {
      return `Обновил существующую строку ${resource.rowNumber} на листе «${resource.sheetName}».`;
    }
    if (resource?.sheetName) {
      return `Обновил данные на листе «${resource.sheetName}».`;
    }
  }

  const message = friendlyResultMessage(result);
  const action = plan.actions.find((candidate) => candidate.id === result.actionId);
  if (
    action?.type === "create_task" &&
    action.payload.dueDateText &&
    !message.includes(action.payload.dueDateText)
  ) {
    return `${message} Срок: ${ensurePeriod(action.payload.dueDateText)}`;
  }

  return message;
}

function buildConclusion(plan: ActionPlan, results: ActionResult[]) {
  const succeeded = results.filter((result) => result.status === "succeeded");
  if (!succeeded.length) return "";

  const incomplete = results.some((result) => result.status !== "succeeded");
  if (incomplete) {
    return "Однозначная часть запроса выполнена; остальные действия не изменялись.";
  }

  const verifiedSheetUpdate = succeeded.some(
    (result) =>
      result.actionType === "update_sheet" &&
      /проверено повторным чтением|повторная запись не потребовалась/iu.test(
        result.message,
      ),
  );
  if (verifiedSheetUpdate) {
    return "Запись проверена после обновления; остальные поля строки не менялись.";
  }

  const target = plan.strategicPlan?.targetResources.find(
    (resource) => resource.type === "google_sheet" && resource.rowNumber,
  );
  if (
    target &&
    succeeded.some((result) => result.actionType === "update_sheet")
  ) {
    return "Обновлена существующая строка; новая строка не создавалась.";
  }

  return "";
}

function findTargetResource(plan: ActionPlan, result: ActionResult) {
  const strategicAction = plan.strategicPlan?.actions.find(
    (action) =>
      action.kind === "execute_action" &&
      action.linkedActionId === result.actionId,
  );
  if (!strategicAction) return undefined;

  return plan.strategicPlan?.targetResources.find(
    (resource): resource is StrategicTargetResource =>
      resource.type === "google_sheet",
  );
}

function extractNumberChanges(message: string) {
  return message
    .split(/\n|(?<=\.)\s+/u)
    .map((line) => line.trim())
    .filter((line) => /-?\d+(?:[.,]\d+)?\s*→\s*-?\d+(?:[.,]\d+)?/u.test(line))
    .map((line) => ensurePeriod(line));
}

function friendlyResultMessage(result: ActionResult) {
  return result.message
    .replace(/\s*Изменение проверено повторным чтением\.?/giu, "")
    .replace(/\s*Проверенный диапазон:\s*[^.]+\.?/giu, "")
    .replace(/^Blueprint подготовлен:/iu, "Структура таблицы подготовлена:")
    .replace(/^Действие\s+[a-z_]+/iu, friendlyActionName(result.actionType))
    .replace(/Mock-действие\s+[a-z_]+\s+подготовлено\.?/giu, "План изменения подготовлен.")
    .replace(/Реальное внешнее действие не выполнялось\.?/giu, "Изменение не выполнено.")
    .replace(/\b(?:payload|confidence)\b/giu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

function friendlyPolicyQuestion(question: string, plan: ActionPlan) {
  if (/^Подтверди опасное действие:/iu.test(question)) {
    const actionType = plan.actions.find((action) =>
      question.includes(action.type),
    )?.type;
    return `Подтверди: ${lowerFirst(friendlyActionName(actionType ?? plan.actions[0]?.type))}.`;
  }
  return question.trim();
}

function friendlyActionName(type: AssistantAction["type"] | undefined) {
  switch (type) {
    case "update_sheet":
      return "Изменение данных в Google Sheets";
    case "create_sheet_tab":
      return "Изменение структуры Google Sheets";
    case "create_task":
      return "Создание задачи в TickTick";
    case "update_task":
      return "Изменение задачи в TickTick";
    case "complete_task":
      return "Завершение задачи в TickTick";
    case "create_calendar_event":
      return "Создание события в календаре";
    case "update_calendar_event":
      return "Изменение события в календаре";
    default:
      return "Это изменение";
  }
}

function isConfirmationQuestion(question: string) {
  return /^Подтверди/iu.test(question.trim());
}

function section(title: string, lines: string[]) {
  return [title, ...unique(lines).map((line) => `- ${line}`)].join("\n");
}

function joinSentences(first: string, second: string) {
  const title = ensurePeriod(first.trim());
  const reason = second.trim();
  return reason && normalize(reason) !== normalize(first)
    ? `${title} ${ensurePeriod(reason)}`
    : title;
}

function formatSuggestion(
  suggestion: NonNullable<ActionPlan["strategicPlan"]>["suggestions"][number],
) {
  if (!suggestion.proposedTask) {
    return joinSentences(suggestion.title, suggestion.reason);
  }

  const dueDate = suggestion.proposedTask.dueDateText
    ? `, срок ${suggestion.proposedTask.dueDateText}`
    : "";
  return `Создать одну задачу в TickTick: «${suggestion.proposedTask.title}»${dueDate}?`;
}

function ensurePeriod(value: string) {
  const trimmed = value.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function lowerFirst(value: string) {
  return value ? `${value[0].toLocaleLowerCase("ru")}${value.slice(1)}` : value;
}

function normalize(value: string) {
  return value
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
