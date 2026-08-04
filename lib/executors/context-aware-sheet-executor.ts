import type {
  ActionResult,
  UpdateSheetAction,
} from "@/lib/agents/assistant/types";
import {
  buildSheetProfile,
  columnName,
} from "@/lib/integrations/google-sheets/sheet-profile";
import type {
  ExistingSpreadsheetMetadata,
  GoogleSheetsAdapter,
  SheetColumnProfile,
  SheetGridMetadata,
  SheetScalar,
} from "@/lib/integrations/google-sheets/types";

const MAX_PROFILE_CELLS = 480;
const SAFE_METRIC_KEYS = new Set([
  "actual_sends",
  "replies",
  "interviews",
  "pilot_discussions",
  "reply_conversion",
]);

export async function executeContextAwareSheetUpdate({
  action,
  adapter,
  metadata,
}: {
  action: UpdateSheetAction;
  adapter: GoogleSheetsAdapter;
  metadata: ExistingSpreadsheetMetadata;
}): Promise<ActionResult | null> {
  if (action.payload.operation !== "update_cells") return null;
  const coordinate = parseSingleCellRange(action.payload.range);
  const desiredValue = action.payload.values?.[0]?.[0];

  if (
    !coordinate ||
    action.payload.values?.length !== 1 ||
    action.payload.values[0]?.length !== 1 ||
    desiredValue === undefined
  ) {
    return null;
  }

  const tab = metadata.tabs.find(
    (candidate) => candidate.title === coordinate.sheetName,
  );
  if (!tab) {
    return failure(
      action,
      `Лист «${coordinate.sheetName}» не найден в таблице «${metadata.title}».`,
      "sheet_tab_not_found",
    );
  }

  const profileColumnCount = Math.max(1, Math.min(tab.columnCount, 12));
  const profileRowCount = Math.max(
    1,
    Math.min(
      tab.rowCount,
      Math.floor(MAX_PROFILE_CELLS / profileColumnCount),
    ),
  );
  const profileRange = `${quoteSheetTitle(tab.title)}!A1:${columnName(profileColumnCount - 1)}${profileRowCount}`;

  const [profileValues, profileGrid, targetGrid, current] = await Promise.all([
    adapter.readRange({
      spreadsheetId: metadata.spreadsheetId,
      range: profileRange,
    }),
    adapter.readSheetGridMetadata({
      spreadsheetId: metadata.spreadsheetId,
      range: profileRange,
    }),
    adapter.readSheetGridMetadata({
      spreadsheetId: metadata.spreadsheetId,
      range: action.payload.range,
    }),
    adapter.readRange({
      spreadsheetId: metadata.spreadsheetId,
      range: action.payload.range,
    }),
  ]);
  const profile = buildSheetProfile({
    spreadsheet: metadata,
    tab,
    values: profileValues.values,
    gridMetadata: profileGrid,
  });
  const column = profile.columns[coordinate.columnIndex];

  if (!column) {
    return failure(
      action,
      "Не удалось определить назначение целевой колонки.",
      "sheet_column_profile_missing",
    );
  }
  if (coordinate.rowNumber <= profile.headerRowNumber) {
    return needsConfirmation(
      action,
      "Изменение заголовка или служебной строки требует подтверждения.",
    );
  }
  const formula = findCellFormula(
    targetGrid,
    coordinate.rowIndex,
    coordinate.columnIndex,
  );
  if (formula) {
    return needsClarification(
      action,
      `Ячейка ${column.columnLetter}${coordinate.rowNumber} содержит формулу ${formula}. Её не перезаписываю: нужно обновить первичный источник данных.`,
      "sheet_formula_source_required",
    );
  }
  if (
    isCellProtected(
      targetGrid,
      coordinate.rowIndex,
      coordinate.columnIndex,
    )
  ) {
    return needsConfirmation(
      action,
      `Ячейка ${column.columnLetter}${coordinate.rowNumber} защищена правилами Google Sheets.`,
    );
  }
  if (!isSafeWritableColumn(column, profile.metricColumns)) {
    return needsConfirmation(
      action,
      `Колонка «${column.header}» защищена: она относится к ключевым или стратегическим данным и не меняется автоматически.`,
    );
  }

  const currentValue = current.values[0]?.[0] ?? null;
  if (sameCellValue(currentValue, desiredValue)) {
    return success(
      action,
      `Значение ${column.header} уже равно ${formatValue(desiredValue)}. Повторная запись не потребовалась.`,
    );
  }
  if (
    isNumericMetric(column, profile.metricColumns) &&
    (!isFiniteCellNumber(currentValue) || !isFiniteCellNumber(desiredValue))
  ) {
    return needsClarification(
      action,
      `Для метрики «${column.header}» ожидались числовые текущее и новое значения.`,
      "sheet_metric_value_invalid",
    );
  }

  await adapter.updateCells({
    spreadsheetId: metadata.spreadsheetId,
    range: action.payload.range,
    values: [[desiredValue]],
  });
  const verification = await adapter.readRange({
    spreadsheetId: metadata.spreadsheetId,
    range: action.payload.range,
  });
  const verifiedValue = verification.values[0]?.[0] ?? null;

  if (!sameCellValue(verifiedValue, desiredValue)) {
    return failure(
      action,
      `Google Sheets принял запись, но повторное чтение ${action.payload.range} не подтвердило новое значение.`,
      "sheet_write_verification_failed",
    );
  }

  return success(
    action,
    `${column.header}: ${formatValue(currentValue)} → ${formatValue(verifiedValue)}. Изменение проверено повторным чтением.`,
  );
}

function isSafeWritableColumn(
  column: SheetColumnProfile,
  metricColumns: string[],
) {
  if (column.role === "status" && column.updatePolicy === "replace") {
    return true;
  }
  if (column.semanticKey === "updated_at") return true;
  if (!metricColumns.includes(column.semanticKey)) return false;
  if (column.semanticKey === "planned_sends") return false;

  return (
    SAFE_METRIC_KEYS.has(column.semanticKey) ||
    column.updatePolicy === "increment" ||
    column.updatePolicy === "replace"
  );
}

function isNumericMetric(
  column: SheetColumnProfile,
  metricColumns: string[],
) {
  return (
    metricColumns.includes(column.semanticKey) &&
    column.semanticKey !== "updated_at"
  );
}

function findCellFormula(
  metadata: SheetGridMetadata,
  rowIndex: number,
  columnIndex: number,
) {
  return metadata.formulaCells?.find(
    (cell) =>
      cell.rowIndex === rowIndex && cell.columnIndex === columnIndex,
  )?.formula;
}

function isCellProtected(
  metadata: SheetGridMetadata,
  rowIndex: number,
  columnIndex: number,
) {
  return (metadata.protectedRanges ?? []).some((range) => {
    const rowMatches =
      rowIndex >= (range.startRowIndex ?? 0) &&
      (range.endRowIndex === undefined || rowIndex < range.endRowIndex);
    const columnMatches =
      columnIndex >= (range.startColumnIndex ?? 0) &&
      (range.endColumnIndex === undefined ||
        columnIndex < range.endColumnIndex);
    return rowMatches && columnMatches;
  });
}

function parseSingleCellRange(range: string) {
  const separator = range.indexOf("!");
  if (separator < 1) return null;
  const sheetName = unquoteSheetTitle(range.slice(0, separator));
  const coordinates = range.slice(separator + 1).replace(/\$/g, "");
  const match = coordinates.match(
    /^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/iu,
  );
  if (!match) return null;
  const startColumn = columnIndex(match[1]);
  const startRow = Number(match[2]);
  const endColumn = columnIndex(match[3] ?? match[1]);
  const endRow = Number(match[4] ?? match[2]);
  if (startColumn !== endColumn || startRow !== endRow || startRow < 1) {
    return null;
  }

  return {
    sheetName,
    columnIndex: startColumn,
    rowNumber: startRow,
    rowIndex: startRow - 1,
  };
}

function sameCellValue(left: SheetScalar, right: SheetScalar) {
  if (left === right) return true;
  if (isFiniteCellNumber(left) && isFiniteCellNumber(right)) {
    return Number(left) === Number(right);
  }
  return String(left ?? "").trim() === String(right ?? "").trim();
}

function isFiniteCellNumber(value: SheetScalar) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Number(value.replace(/\s/g, "").replace(",", ".")));
}

function formatValue(value: SheetScalar) {
  return value === null || value === "" ? "пусто" : String(value);
}

function columnIndex(name: string) {
  return [...name.toUpperCase()].reduce(
    (result, character) => result * 26 + character.charCodeAt(0) - 64,
    0,
  ) - 1;
}

function quoteSheetTitle(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

function unquoteSheetTitle(title: string) {
  return title.startsWith("'") && title.endsWith("'")
    ? title.slice(1, -1).replace(/''/g, "'")
    : title;
}

function success(action: UpdateSheetAction, message: string): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "succeeded",
    message,
  };
}

function needsClarification(
  action: UpdateSheetAction,
  message: string,
  errorCode: string,
): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "needs_clarification",
    message,
    errorCode,
  };
}

function needsConfirmation(
  action: UpdateSheetAction,
  message: string,
): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "needs_confirmation",
    message,
    errorCode: "sheet_protected_cell_confirmation_required",
  };
}

function failure(
  action: UpdateSheetAction,
  message: string,
  errorCode: string,
): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "failed",
    message,
    errorCode,
  };
}
