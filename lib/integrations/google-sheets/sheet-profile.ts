import { createHash } from "node:crypto";
import type {
  ExistingSpreadsheetMetadata,
  ExistingSpreadsheetTab,
  SheetColumnDataType,
  SheetColumnProfile,
  SheetGridMetadata,
  SheetProfile,
  SheetScalar,
} from "./types";

const HEADER_SCAN_LIMIT = 6;

export function buildSheetProfile({
  spreadsheet,
  tab,
  values,
  gridMetadata,
  projectId,
  linkedTickTickProjectId,
}: {
  spreadsheet: ExistingSpreadsheetMetadata;
  tab: ExistingSpreadsheetTab;
  values: SheetScalar[][];
  gridMetadata?: SheetGridMetadata;
  projectId?: string;
  linkedTickTickProjectId?: string;
}): SheetProfile {
  const headerIndex = findHeaderRowIndex(values);
  const headers = values[headerIndex] ?? [];
  const formulaColumns = new Set(gridMetadata?.formulaColumns ?? []);
  const explicitlyProtected = new Set(
    gridMetadata?.protectedColumns ?? [],
  );
  const columns = headers.map((value, index) =>
    classifyColumn({
      index,
      header: formatHeader(value, index),
      sampleValues: values
        .slice(headerIndex + 1)
        .map((row) => row[index] ?? null),
      isFormula: formulaColumns.has(index),
      isExplicitlyProtected: explicitlyProtected.has(index),
    }),
  );
  const entityType = inferEntityType(columns);
  const keyColumns = selectKeyColumns(columns, entityType);
  const protectedColumns = columns
    .filter((column) => column.isProtected)
    .map((column) => column.semanticKey);

  return {
    version: 1,
    spreadsheetId: spreadsheet.spreadsheetId,
    sheetId: tab.sheetId,
    sheetName: tab.title,
    purpose: inferPurpose(entityType, tab.title),
    entityType,
    headerRowNumber: headerIndex + 1,
    columns,
    keyColumns,
    metricColumns: columns
      .filter(
        (column) =>
          column.role === "metric" ||
          isMetricSemanticKey(column.semanticKey),
      )
      .map((column) => column.semanticKey),
    statusColumns: semanticKeys(columns, "status"),
    textColumns: semanticKeys(columns, "text"),
    formulaColumns: columns
      .filter((column) => column.isFormula)
      .map((column) => column.semanticKey),
    protectedColumns,
    rowMatchingRules: {
      keyColumns,
      minimumConfidence: 0.78,
      ambiguityDelta: 0.1,
    },
    ...(projectId ? { projectId } : {}),
    ...(linkedTickTickProjectId ? { linkedTickTickProjectId } : {}),
    fingerprint: createFingerprint({
      spreadsheetId: spreadsheet.spreadsheetId,
      sheetId: tab.sheetId,
      headerRowNumber: headerIndex + 1,
      columns,
    }),
  };
}

export function columnName(index: number) {
  let result = "";
  let current = index + 1;

  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }

  return result;
}

export function parseRangeColumnIndexes(range: string) {
  const coordinates = range.split("!").at(-1)?.replace(/\$/g, "") ?? "";
  const [start, end = start] = coordinates.split(":");
  const startMatch = start.match(/^([A-Z]+)/i);
  const endMatch = end.match(/^([A-Z]+)/i);

  if (!startMatch || !endMatch) {
    return null;
  }

  return {
    start: columnIndex(startMatch[1]),
    end: columnIndex(endMatch[1]),
  };
}

function classifyColumn({
  index,
  header,
  sampleValues,
  isFormula,
  isExplicitlyProtected,
}: {
  index: number;
  header: string;
  sampleValues: SheetScalar[];
  isFormula: boolean;
  isExplicitlyProtected: boolean;
}): SheetColumnProfile {
  const normalized = normalizeText(header);
  const semanticKey = inferSemanticKey(normalized, index);
  const isStrategicText =
    /перв.*сообщ|повтор.*сообщ|follow.?up|оффер|offer|техническ|реализац|скрипт|гипотез/i.test(
      normalized,
    );
  const isPlannedMetric = /план|целев|target/i.test(normalized);
  const isMetric =
    /отправ|рассыл|ответ|интервью|созвон|пилот|лид|заяв|продаж|выруч|расход|колич|конверс|cpl|cac|cpo|roas|romi|факт/i.test(
      normalized,
    );
  const isStatus = /статус|состояни|этап|стадия/i.test(normalized);
  const isComment = /коммент|замет|примечан|итог/i.test(normalized);
  const isKey =
    /сегмент|оффер.*результ|результ.*оффер|направлен|контакт|клиент|партнер|партнёр|проект|имя|названи|entity|(^|_)id($|_)/i.test(
      normalized,
    );
  const protectedByMeaning =
    isStrategicText || isPlannedMetric || (!isMetric && !isStatus && !isComment && !isKey);
  const isProtected =
    isFormula || isExplicitlyProtected || protectedByMeaning;
  const role = isFormula
    ? "formula"
    : isKey
      ? "key"
      : isStatus
        ? "status"
        : isMetric
          ? "metric"
          : isComment || isStrategicText
            ? "text"
            : "unknown";
  const updatePolicy = isFormula
    ? "formula"
    : isProtected
      ? "protected"
      : role === "metric"
        ? /факт|отправ|ответ|интервью|созвон|лид|заяв|продаж|колич/i.test(
            normalized,
          )
          ? "increment"
          : "replace"
        : role === "status"
          ? "replace"
          : role === "text"
            ? "append_text"
            : "preserve";

  return {
    index,
    columnLetter: columnName(index),
    header,
    semanticKey,
    role,
    dataType: inferDataType(sampleValues, normalized),
    updatePolicy,
    isFormula,
    isProtected,
  };
}

function inferEntityType(
  columns: SheetColumnProfile[],
): SheetProfile["entityType"] {
  const text = columns.map((column) => normalizeText(column.header)).join(" ");

  if (
    /сегмент/.test(text) &&
    /отправ|рассыл|ответ|интервью|пилот|конверс/.test(text)
  ) {
    return "outreach_segment";
  }

  if (/задач/.test(text) && /статус|дедлайн|срок/.test(text)) {
    return "task";
  }

  if (/дат/.test(text) && /метрик|показател|значени/.test(text)) {
    return "metric_record";
  }

  if (
    /дат/.test(text) &&
    /действ|активност|событи|рассыл|отправ/.test(text) &&
    !/сегмент/.test(text)
  ) {
    return "activity_log";
  }

  return "generic_table";
}

function selectKeyColumns(
  columns: SheetColumnProfile[],
  entityType: SheetProfile["entityType"],
) {
  const explicit = columns
    .filter((column) => column.role === "key")
    .map((column) => column.semanticKey);

  if (explicit.length) {
    return explicit.slice(0, entityType === "outreach_segment" ? 2 : 1);
  }

  const firstMutableText = columns.find(
    (column) =>
      column.dataType === "string" &&
      !column.isFormula &&
      column.role !== "status",
  );

  return firstMutableText ? [firstMutableText.semanticKey] : [];
}

function inferPurpose(
  entityType: SheetProfile["entityType"],
  sheetName: string,
) {
  switch (entityType) {
    case "outreach_segment":
      return "Управление сегментами, рассылками и конверсией";
    case "task":
      return "Операционное управление задачами";
    case "metric_record":
      return "Учёт показателей и план-факт";
    case "activity_log":
      return "Журнал операционных действий";
    default:
      return `Данные листа «${sheetName}»`;
  }
}

function findHeaderRowIndex(values: SheetScalar[][]) {
  let bestIndex = 0;
  let bestScore = -1;

  for (
    let index = 0;
    index < Math.min(values.length, HEADER_SCAN_LIMIT);
    index += 1
  ) {
    const row = values[index] ?? [];
    const populated = row.filter(
      (value) => value !== null && String(value).trim(),
    );
    const words = populated.filter((value) => typeof value === "string");
    const knownHeaders = words.filter((value) =>
      /сегмент|статус|план|факт|отправ|ответ|дата|коммент|задач|метрик|конверс|интервью|оффер/i.test(
        value,
      ),
    );
    const score = populated.length * 2 + words.length + knownHeaders.length * 4;

    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  return bestIndex;
}

function inferDataType(
  values: SheetScalar[],
  normalizedHeader: string,
): SheetColumnDataType {
  if (/дат|дедлайн|срок|время|timestamp/.test(normalizedHeader)) {
    return "date";
  }

  const types = new Set(
    values
      .filter((value) => value !== null && value !== "")
      .map((value) => typeof value),
  );

  if (!types.size) {
    return "empty";
  }

  if (types.size > 1) {
    return "mixed";
  }

  const type = [...types][0];
  return type === "number" || type === "boolean" ? type : "string";
}

function inferSemanticKey(normalizedHeader: string, index: number) {
  const mappings: Array<[RegExp, string]> = [
    [/сегмент/, "segment"],
    [/оффер.*результ|результ.*оффер/, "offer_result"],
    [/перв.*сообщ/, "first_message"],
    [/дата.*(?:follow.?up|повтор)|(?:follow.?up|повтор).*дата|след.*контакт.*дат/, "follow_up_at"],
    [/след.*действ|next.?action/, "next_action"],
    [/дедлайн|срок/, "due_date"],
    [/повтор.*сообщ|follow.?up/, "follow_up_message"],
    [/техническ|реализац/, "technical_implementation"],
    [/план.*отправ|отправ.*план/, "planned_sends"],
    [/факт.*отправ|отправ.*факт|фактическ.*отправ/, "actual_sends"],
    [/отправ|рассыл/, "actual_sends"],
    [/конверс.*ответ|ответ.*конверс/, "reply_conversion"],
    [/ответ/, "replies"],
    [/интервью/, "interviews"],
    [/пилот/, "pilot_discussions"],
    [/статус.*коммент|коммент.*статус/, "status_comment"],
    [/статус|состояни/, "status"],
    [/дата|timestamp|обновлен/, "updated_at"],
    [/задач/, "task"],
    [/ответствен/, "owner"],
    [/приоритет/, "priority"],
  ];

  return (
    mappings.find(([pattern]) => pattern.test(normalizedHeader))?.[1] ??
    `column_${index + 1}`
  );
}

function semanticKeys(
  columns: SheetColumnProfile[],
  role: SheetColumnProfile["role"],
) {
  return columns
    .filter((column) => column.role === role)
    .map((column) => column.semanticKey);
}

function isMetricSemanticKey(value: string) {
  return [
    "planned_sends",
    "actual_sends",
    "replies",
    "interviews",
    "pilot_discussions",
    "reply_conversion",
  ].includes(value);
}

function formatHeader(value: SheetScalar | undefined, index: number) {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text || `Колонка ${columnName(index)}`;
}

function normalizeText(value: string) {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function createFingerprint(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}

function columnIndex(name: string) {
  return [...name.toUpperCase()].reduce(
    (result, character) =>
      result * 26 + character.charCodeAt(0) - 64,
    0,
  ) - 1;
}
