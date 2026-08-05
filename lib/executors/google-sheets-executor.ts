import type {
  ActionResult,
  AssistantAction,
  ExistingSheetTarget,
} from "@/lib/agents/assistant/types";
import { createGoogleSheetsAdapterFromEnv } from "@/lib/integrations/google-sheets/google-sheets-adapter";
import {
  formatGoogleSheetsWorkspaceContext,
  inspectSpreadsheet,
} from "@/lib/integrations/google-sheets/document-context";
import {
  buildSheetProfile,
  columnName,
  parseRangeColumnIndexes,
} from "@/lib/integrations/google-sheets/sheet-profile";
import {
  buildSheetRowEntities,
  isUnambiguousRowMatch,
  matchSheetRows,
} from "@/lib/integrations/google-sheets/row-matcher";
import {
  createOwnProjectOperationsBlueprint,
  OWN_PROJECT_OPERATIONS_BLUEPRINT_ID,
} from "@/lib/integrations/google-sheets/launch-tracker-blueprint";
import type {
  ExistingSpreadsheetMetadata,
  ExistingSpreadsheetSummary,
  GoogleSheetsAdapter,
} from "@/lib/integrations/google-sheets/types";
import { executeContextAwareSheetUpdate } from "./context-aware-sheet-executor";

type GoogleSheetsAction = Extract<
  AssistantAction,
  {
    type:
      | "create_sheet"
      | "create_sheet_tab"
      | "find_sheet"
      | "read_sheet"
      | "update_sheet"
      | "create_sheet_blueprint";
  }
>;

type FindSheetAction = Extract<GoogleSheetsAction, { type: "find_sheet" }>;

type SheetResolution =
  | {
      kind: "resolved";
      metadata: ExistingSpreadsheetMetadata;
    }
  | {
      kind: "not_found";
      title: string;
    }
  | {
      kind: "ambiguous";
      title: string;
      matches: ExistingSpreadsheetSummary[];
    };

export async function executeGoogleSheetsAction(
  action: AssistantAction,
  adapterOverride?: GoogleSheetsAdapter | null,
): Promise<ActionResult | null> {
  if (!isGoogleSheetsAction(action)) {
    return null;
  }

  if (action.type === "create_sheet_blueprint") {
    const blueprint = createOwnProjectOperationsBlueprint();

    return success(
      action,
      `Blueprint подготовлен: ${blueprint.title}. Листов: ${blueprint.tabs.length}.`,
    );
  }

  const adapter =
    adapterOverride === undefined
      ? createGoogleSheetsAdapterFromEnv()
      : adapterOverride;

  if (!adapter) {
    return failure(
      action,
      "Google OAuth не настроен. Добавьте GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET и GOOGLE_REFRESH_TOKEN.",
      "google_oauth_not_configured",
    );
  }

  try {
    switch (action.type) {
      case "find_sheet": {
        const matches = await adapter.findSpreadsheetsByTitle(
          action.payload.title,
        );

        return formatSearchResult(action, matches);
      }

      case "read_sheet": {
        const resolved = await resolveExistingSheet(
          adapter,
          action.payload.target,
        );

        if (resolved.kind !== "resolved") {
          return formatResolutionFailure(action, resolved);
        }

        if (!action.payload.range) {
          const inspected = await inspectSpreadsheet(
            adapter,
            resolved.metadata,
          );

          return success(
            action,
            formatGoogleSheetsWorkspaceContext({
              availableDocuments: [resolved.metadata],
              inspectedDocuments: [inspected],
            }),
          );
        }

        const range = await adapter.readRange({
          spreadsheetId: resolved.metadata.spreadsheetId,
          range: action.payload.range,
        });

        return success(
          action,
          [
            `Таблица «${resolved.metadata.title}», диапазон ${range.range}:`,
            formatRangeValues(range.values),
            resolved.metadata.spreadsheetUrl,
          ].join("\n"),
          {
            kind: "sheet_range",
            spreadsheetId: resolved.metadata.spreadsheetId,
            spreadsheetTitle: resolved.metadata.title,
            range: range.range,
            values: range.values,
          },
        );
      }

      case "create_sheet": {
        const blueprintId =
          action.payload.blueprintId || OWN_PROJECT_OPERATIONS_BLUEPRINT_ID;

        if (blueprintId !== OWN_PROJECT_OPERATIONS_BLUEPRINT_ID) {
          return failure(
            action,
            `Неизвестный blueprint: ${blueprintId}.`,
            "unknown_sheet_blueprint",
          );
        }

        const blueprint = createOwnProjectOperationsBlueprint(
          action.payload.title,
        );
        const spreadsheet = await adapter.createSpreadsheet(
          blueprint,
          `create_sheet:${blueprint.id}:${blueprint.title}`,
        );

        return success(
          action,
          [
            spreadsheet.reused
              ? "Использована ранее созданная таблица."
              : "Таблица создана.",
            spreadsheet.spreadsheetUrl,
          ].join(" "),
        );
      }

      case "create_sheet_tab": {
        const result = await adapter.createSheetTab(action.payload);

        return success(
          action,
          result.reused
            ? `Лист «${action.payload.title}» уже существует.`
            : `Лист «${action.payload.title}» создан.`,
        );
      }

      case "update_sheet": {
        const resolved = await resolveExistingSheet(
          adapter,
          action.payload.target,
        );

        if (resolved.kind !== "resolved") {
          return formatResolutionFailure(action, resolved);
        }

        const spreadsheetId = resolved.metadata.spreadsheetId;

        if (action.payload.operation === "clear_range") {
          await adapter.clearRange({
            spreadsheetId,
            range: action.payload.range,
          });
          return success(
            action,
            `Диапазон ${action.payload.range} очищен.`,
          );
        }

        const values = action.payload.values;

        if (!values?.length) {
          return failure(
            action,
            "Для обновления таблицы нужны значения.",
            "sheet_values_required",
          );
        }

        if (action.payload.operation === "append_rows") {
          const appendGuard = await guardEntityAppend({
            adapter,
            metadata: resolved.metadata,
            range: action.payload.range,
            values,
          });

          if (appendGuard) {
            return needsClarification(action, appendGuard);
          }

          const appendResult = await adapter.appendRows({
            spreadsheetId,
            range: action.payload.range,
            values,
            idempotencyKey: [
              action.id,
              spreadsheetId,
              action.payload.range,
              JSON.stringify(values),
            ].join(":"),
          });

          if (appendResult.reused) {
            return success(
              action,
              `Эта запись уже была выполнена ранее в таблице «${resolved.metadata.title}». Дубликат не создан.`,
            );
          }

          if (appendResult.updatedRange) {
            const verification = await adapter.readRange({
              spreadsheetId,
              range: appendResult.updatedRange,
            });

            if (verification.values.length < values.length) {
              return failure(
                action,
                "Google Sheets сообщил о записи, но проверка добавленных строк не прошла.",
                "sheet_write_verification_failed",
              );
            }
          }

          return success(
            action,
            [
              `Данные добавлены в таблицу «${resolved.metadata.title}».`,
              appendResult.updatedRange
                ? `Проверенный диапазон: ${appendResult.updatedRange}.`
                : `Диапазон: ${action.payload.range}.`,
            ].join(" "),
          );
        }

        const contextAwareResult = await executeContextAwareSheetUpdate({
          action,
          adapter,
          metadata: resolved.metadata,
        });

        if (contextAwareResult) {
          return contextAwareResult;
        }

        const protectedUpdate = await findProtectedUpdate({
          adapter,
          metadata: resolved.metadata,
          range: action.payload.range,
        });

        if (protectedUpdate) {
          return needsClarification(
            action,
            `Колонка «${protectedUpdate}» защищена от автоматической перезаписи. Для такого изменения нужно отдельное подтверждение.`,
          );
        }

        await adapter.updateCells({
          spreadsheetId,
          range: action.payload.range,
          values,
        });
        return success(
          action,
          `Диапазон ${action.payload.range} обновлён.`,
        );
      }
    }
  } catch (error) {
    if (isDriveScopeError(error)) {
      return failure(
        action,
        "Для поиска всех существующих таблиц обновите GOOGLE_REFRESH_TOKEN со scope drive.metadata.readonly.",
        "google_drive_metadata_scope_required",
      );
    }

    return failure(
      action,
      error instanceof Error ? error.message : "Google Sheets operation failed.",
      "google_sheets_failed",
    );
  }
}

async function guardEntityAppend({
  adapter,
  metadata,
  range,
  values,
}: {
  adapter: GoogleSheetsAdapter;
  metadata: ExistingSpreadsheetMetadata;
  range: string;
  values: Array<Array<string | number | boolean | null>>;
}) {
  if (values.length !== 1) {
    return null;
  }

  const context = await loadTargetSheetProfile(adapter, metadata, range);

  if (
    !context ||
    (context.profile.entityType !== "outreach_segment" &&
      context.profile.entityType !== "task" &&
      context.profile.entityType !== "contact_record")
  ) {
    return null;
  }

  const keyValues = context.profile.keyColumns.flatMap((semanticKey) => {
    const column = context.profile.columns.find(
      (candidate) => candidate.semanticKey === semanticKey,
    );
    const value = column ? values[0][column.index] : null;
    return value === null || value === undefined || value === ""
      ? []
      : [String(value)];
  });

  if (!keyValues.length) {
    return null;
  }

  const matches = matchSheetRows(keyValues.join(" "), context.entities);

  if (!isUnambiguousRowMatch(matches, context.profile)) {
    return null;
  }

  if (context.profile.entityType === "contact_record") {
    return `Контакт «${matches[0].entity.rowKey}» уже есть в таблице — новую строку не добавил, чтобы не создать дубль.`;
  }

  return `Нашёл существующую строку «${matches[0].entity.rowKey}» — новую не добавил, чтобы не создать дубль. Уточни только смысл числа: прибавить его к текущему факту или заменить текущее значение?`;
}

async function findProtectedUpdate({
  adapter,
  metadata,
  range,
}: {
  adapter: GoogleSheetsAdapter;
  metadata: ExistingSpreadsheetMetadata;
  range: string;
}) {
  const columns = parseRangeColumnIndexes(range);

  if (!columns) {
    return null;
  }

  const context = await loadTargetSheetProfile(adapter, metadata, range);

  if (!context) {
    return null;
  }

  return (
    context.profile.columns.find(
      (column) =>
        column.index >= columns.start &&
        column.index <= columns.end &&
        column.isProtected,
    )?.header ?? null
  );
}

async function loadTargetSheetProfile(
  adapter: GoogleSheetsAdapter,
  metadata: ExistingSpreadsheetMetadata,
  range: string,
) {
  const sheetName = extractSheetTitle(range);
  const tab = metadata.tabs.find((candidate) => candidate.title === sheetName);

  if (!tab) {
    return null;
  }

  const rowCount = Math.max(1, Math.min(tab.rowCount, 100));
  const columnCount = Math.max(1, Math.min(tab.columnCount, 12));
  const sampleRange = `${quoteSheetTitle(tab.title)}!A1:${columnName(columnCount - 1)}${rowCount}`;

  try {
    const [sample, gridMetadata] = await Promise.all([
      adapter.readRange({
        spreadsheetId: metadata.spreadsheetId,
        range: sampleRange,
      }),
      adapter.readSheetGridMetadata({
        spreadsheetId: metadata.spreadsheetId,
        range: sampleRange,
      }),
    ]);
    const profile = buildSheetProfile({
      spreadsheet: metadata,
      tab,
      values: sample.values,
      gridMetadata,
    });

    return {
      profile,
      entities: buildSheetRowEntities(profile, sample.values),
    };
  } catch {
    return null;
  }
}

function extractSheetTitle(range: string) {
  const rawTitle = range.slice(0, range.indexOf("!"));

  return rawTitle.startsWith("'") && rawTitle.endsWith("'")
    ? rawTitle.slice(1, -1).replace(/''/g, "'")
    : rawTitle;
}

function quoteSheetTitle(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

function isGoogleSheetsAction(
  action: AssistantAction,
): action is GoogleSheetsAction {
  return (
    action.type === "create_sheet" ||
    action.type === "create_sheet_tab" ||
    action.type === "find_sheet" ||
    action.type === "read_sheet" ||
    action.type === "update_sheet" ||
    action.type === "create_sheet_blueprint"
  );
}

async function resolveExistingSheet(
  adapter: GoogleSheetsAdapter,
  target: ExistingSheetTarget,
): Promise<SheetResolution> {
  if (target.kind === "id") {
    return {
      kind: "resolved",
      metadata: await adapter.getSpreadsheetMetadata(target.spreadsheetId),
    };
  }

  const matches = await adapter.findSpreadsheetsByTitle(target.title);

  if (!matches.length) {
    return { kind: "not_found", title: target.title };
  }

  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      title: target.title,
      matches,
    };
  }

  return {
    kind: "resolved",
    metadata: await adapter.getSpreadsheetMetadata(matches[0].spreadsheetId),
  };
}

function formatSearchResult(
  action: FindSheetAction,
  matches: ExistingSpreadsheetSummary[],
): ActionResult {
  if (!matches.length) {
    return failure(
      action,
      `Таблица «${action.payload.title}» не найдена.`,
      "sheet_not_found",
    );
  }

  if (matches.length > 1) {
    return needsClarification(
      action,
      [
        "Найдено несколько таблиц с таким названием. Пришлите нужную ссылку:",
        ...matches.map((match) => match.spreadsheetUrl),
      ].join("\n"),
    );
  }

  return success(
    action,
    `Таблица найдена: ${matches[0].spreadsheetUrl}`,
  );
}

function formatResolutionFailure(
  action: GoogleSheetsAction,
  resolution: Exclude<SheetResolution, { kind: "resolved" }>,
): ActionResult {
  if (resolution.kind === "not_found") {
    return failure(
      action,
      `Таблица «${resolution.title}» не найдена.`,
      "sheet_not_found",
    );
  }

  return needsClarification(
    action,
    [
      `Найдено несколько таблиц «${resolution.title}». Пришлите нужную ссылку:`,
      ...resolution.matches.map((match) => match.spreadsheetUrl),
    ].join("\n"),
  );
}

function formatRangeValues(
  values: Array<Array<string | number | boolean | null>>,
) {
  if (!values.length) {
    return "Диапазон пуст.";
  }

  const formatted = values
    .map((row) =>
      row
        .map((value) => (value === null ? "" : String(value)))
        .join(" | "),
    )
    .join("\n");

  return formatted.length <= 2_500
    ? formatted
    : `${formatted.slice(0, 2_500)}\n…результат сокращён.`;
}

function success(
  action: GoogleSheetsAction,
  message: string,
  data?: ActionResult["data"],
): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "succeeded",
    message,
    ...(data ? { data } : {}),
  };
}

function needsClarification(
  action: GoogleSheetsAction,
  message: string,
): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "needs_clarification",
    message,
  };
}

function failure(
  action: GoogleSheetsAction,
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

function isDriveScopeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
    message.includes("insufficient authentication scopes") ||
    message.includes("insufficientPermissions")
  );
}
