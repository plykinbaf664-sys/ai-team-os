import type {
  ActionResult,
  AssistantAction,
} from "@/lib/agents/assistant/types";
import {
  createGoogleSheetsAdapterFromEnv,
} from "@/lib/integrations/google-sheets/google-sheets-adapter";
import {
  createOwnProjectOperationsBlueprint,
  OWN_PROJECT_OPERATIONS_BLUEPRINT_ID,
} from "@/lib/integrations/google-sheets/launch-tracker-blueprint";
import type { GoogleSheetsAdapter } from "@/lib/integrations/google-sheets/types";

type GoogleSheetsAction = Extract<
  AssistantAction,
  {
    type:
      | "create_sheet"
      | "create_sheet_tab"
      | "update_sheet"
      | "create_sheet_blueprint";
  }
>;

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
        if (action.payload.operation === "clear_range") {
          await adapter.clearRange(action.payload);
          return success(action, `Диапазон ${action.payload.range} очищен.`);
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
          await adapter.appendRows({
            ...action.payload,
            values,
            idempotencyKey: [
              action.id,
              action.payload.spreadsheetId,
              action.payload.range,
              JSON.stringify(values),
            ].join(":"),
          });
          return success(action, "Строки добавлены.");
        }

        await adapter.updateCells({
          ...action.payload,
          values,
        });
        return success(action, `Диапазон ${action.payload.range} обновлён.`);
      }
    }
  } catch (error) {
    return failure(
      action,
      error instanceof Error ? error.message : "Google Sheets operation failed.",
      "google_sheets_failed",
    );
  }
}

function isGoogleSheetsAction(
  action: AssistantAction,
): action is GoogleSheetsAction {
  return (
    action.type === "create_sheet" ||
    action.type === "create_sheet_tab" ||
    action.type === "update_sheet" ||
    action.type === "create_sheet_blueprint"
  );
}

function success(
  action: GoogleSheetsAction,
  message: string,
): ActionResult {
  return {
    actionId: action.id,
    actionType: action.type,
    status: "succeeded",
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
