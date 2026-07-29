import { createHash } from "node:crypto";
import { createGoogleAccessTokenProvider } from "./google-auth";
import type {
  CreatedSpreadsheet,
  GoogleSheetBlueprint,
  GoogleSheetsAdapter,
  SheetCellInput,
  SheetChartBlueprint,
  SheetConditionalFormat,
  SheetScalar,
} from "./types";

type FetchImplementation = typeof fetch;

type SpreadsheetMetadata = {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: {
    title?: string;
  };
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
    };
  }>;
  developerMetadata?: Array<{
    metadataKey?: string;
    metadataValue?: string;
  }>;
};

type DriveFile = {
  id?: string;
  name?: string;
  webViewLink?: string;
  appProperties?: Record<string, string>;
};

type DriveListResponse = {
  files?: DriveFile[];
};

type BatchUpdateResponse = {
  replies?: Array<{
    addSheet?: {
      properties?: {
        sheetId?: number;
      };
    };
  }>;
};

const SHEETS_API = "https://sheets.googleapis.com/v4";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const BLUEPRINT_METADATA_KEY = "ai_team_os_blueprint";
const ACTION_METADATA_KEY = "ai_team_os_action";

export function createGoogleSheetsAdapter({
  getAccessToken,
  fetchImplementation = fetch,
}: {
  getAccessToken: () => Promise<string>;
  fetchImplementation?: FetchImplementation;
}): GoogleSheetsAdapter {
  async function requestJson<T>(
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    const accessToken = await getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);

    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetchImplementation(url, {
      ...init,
      headers,
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `Google API request failed with status ${response.status}: ${responseText.slice(0, 1_000)}`,
      );
    }

    return responseText ? (JSON.parse(responseText) as T) : ({} as T);
  }

  async function getSpreadsheet(spreadsheetId: string) {
    const fields = [
      "spreadsheetId",
      "spreadsheetUrl",
      "properties(title)",
      "sheets(properties(sheetId,title))",
      "developerMetadata(metadataKey,metadataValue)",
    ].join(",");

    return requestJson<SpreadsheetMetadata>(
      `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`,
    );
  }

  async function findSpreadsheet(idempotencyHash: string) {
    const query = [
      `mimeType='${SPREADSHEET_MIME_TYPE}'`,
      "trashed=false",
      `appProperties has { key='ai_team_os_key' and value='${idempotencyHash}' }`,
    ].join(" and ");
    const parameters = new URLSearchParams({
      q: query,
      spaces: "drive",
      pageSize: "1",
      fields: "files(id,name,webViewLink,appProperties)",
    });
    const result = await requestJson<DriveListResponse>(
      `${DRIVE_API}/files?${parameters.toString()}`,
    );

    return result.files?.[0] ?? null;
  }

  async function updateDriveState(
    spreadsheetId: string,
    idempotencyHash: string,
    state: "creating" | "complete",
  ) {
    const parameters = new URLSearchParams({
      fields: "id,appProperties",
    });

    await requestJson<DriveFile>(
      `${DRIVE_API}/files/${encodeURIComponent(spreadsheetId)}?${parameters.toString()}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          appProperties: {
            ai_team_os_key: idempotencyHash,
            ai_team_os_state: state,
          },
        }),
      },
    );
  }

  async function applyBlueprint(
    spreadsheetId: string,
    blueprint: GoogleSheetBlueprint,
  ) {
    await requestJson<BatchUpdateResponse>(
      `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: buildBlueprintRequests(blueprint),
        }),
      },
    );
  }

  return {
    async createSpreadsheet(blueprint, idempotencyKey) {
      const idempotencyHash = hashIdempotencyKey(idempotencyKey);
      const marker = blueprintMarker(blueprint);
      const existingFile = await findSpreadsheet(idempotencyHash);

      if (existingFile?.id) {
        const spreadsheet = await getSpreadsheet(existingFile.id);
        const isApplied = spreadsheet.developerMetadata?.some(
          (metadata) =>
            metadata.metadataKey === BLUEPRINT_METADATA_KEY &&
            metadata.metadataValue === marker,
        );

        if (!isApplied) {
          await applyBlueprint(existingFile.id, blueprint);
        }

        await updateDriveState(existingFile.id, idempotencyHash, "complete");

        return toCreatedSpreadsheet(spreadsheet, blueprint.title, true);
      }

      const spreadsheet = await requestJson<SpreadsheetMetadata>(
        `${SHEETS_API}/spreadsheets`,
        {
          method: "POST",
          body: JSON.stringify({
            properties: {
              title: blueprint.title,
              locale: blueprint.locale,
              timeZone: blueprint.timeZone,
            },
            sheets: blueprint.tabs.map((tab, index) => ({
              properties: {
                sheetId: tab.sheetId,
                title: tab.title,
                index,
                gridProperties: {
                  rowCount: tab.rowCount,
                  columnCount: tab.columnCount,
                },
              },
            })),
          }),
        },
      );
      const spreadsheetId = requireString(
        spreadsheet.spreadsheetId,
        "spreadsheetId",
      );

      await updateDriveState(spreadsheetId, idempotencyHash, "creating");
      await applyBlueprint(spreadsheetId, blueprint);
      await updateDriveState(spreadsheetId, idempotencyHash, "complete");

      return toCreatedSpreadsheet(spreadsheet, blueprint.title, false);
    },

    async createSheetTab({ spreadsheetId, title }) {
      const spreadsheet = await getSpreadsheet(spreadsheetId);
      const existing = spreadsheet.sheets?.find(
        (sheet) => sheet.properties?.title === title,
      );

      if (typeof existing?.properties?.sheetId === "number") {
        return { sheetId: existing.properties.sheetId, reused: true };
      }

      const result = await requestJson<BatchUpdateResponse>(
        `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        {
          method: "POST",
          body: JSON.stringify({
            requests: [{ addSheet: { properties: { title } } }],
          }),
        },
      );
      const sheetId = result.replies?.[0]?.addSheet?.properties?.sheetId;

      if (typeof sheetId !== "number") {
        throw new Error("Google Sheets did not return the created sheetId.");
      }

      return { sheetId, reused: false };
    },

    async appendRows({
      spreadsheetId,
      range,
      values,
      idempotencyKey,
    }) {
      const spreadsheet = await getSpreadsheet(spreadsheetId);
      const marker = hashIdempotencyKey(idempotencyKey);

      if (
        spreadsheet.developerMetadata?.some(
          (metadata) =>
            metadata.metadataKey === ACTION_METADATA_KEY &&
            metadata.metadataValue === marker,
        )
      ) {
        return;
      }

      const sheetId = resolveSheetId(spreadsheet, range);

      await requestJson<BatchUpdateResponse>(
        `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        {
          method: "POST",
          body: JSON.stringify({
            requests: [
              {
                appendCells: {
                  sheetId,
                  rows: values.map((row) => ({
                    values: row.map(toScalarCellData),
                  })),
                  fields: "userEnteredValue",
                },
              },
              createMetadataRequest(ACTION_METADATA_KEY, marker),
            ],
          }),
        },
      );
    },

    async updateCells({ spreadsheetId, range, values }) {
      const parameters = new URLSearchParams({
        valueInputOption: "USER_ENTERED",
      });

      await requestJson(
        `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${parameters.toString()}`,
        {
          method: "PUT",
          body: JSON.stringify({
            range,
            majorDimension: "ROWS",
            values,
          }),
        },
      );
    },

    async clearRange({ spreadsheetId, range }) {
      await requestJson(
        `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`,
        {
          method: "POST",
          body: "{}",
        },
      );
    },
  };
}

export function createGoogleSheetsAdapterFromEnv() {
  const getAccessToken = createGoogleAccessTokenProvider();

  return getAccessToken ? createGoogleSheetsAdapter({ getAccessToken }) : null;
}

export function buildBlueprintRequests(blueprint: GoogleSheetBlueprint) {
  const requests: unknown[] = [];

  for (const tab of blueprint.tabs) {
    for (const block of tab.values) {
      const width = Math.max(0, ...block.rows.map((row) => row.length));

      if (!block.rows.length || !width) {
        continue;
      }

      requests.push({
        updateCells: {
          range: {
            sheetId: tab.sheetId,
            startRowIndex: block.startRowIndex,
            endRowIndex: block.startRowIndex + block.rows.length,
            startColumnIndex: block.startColumnIndex,
            endColumnIndex: block.startColumnIndex + width,
          },
          rows: block.rows.map((row) => ({
            values: padRow(row, width).map(toCellData),
          })),
          fields: "userEnteredValue",
        },
      });
    }

    for (const range of tab.headerRanges) {
      requests.push({
        repeatCell: {
          range,
          cell: {
            userEnteredFormat: {
              backgroundColorStyle: {
                rgbColor: { red: 0.92, green: 0.92, blue: 0.92 },
              },
              textFormat: {
                bold: true,
                foregroundColorStyle: {
                  rgbColor: { red: 0.1, green: 0.1, blue: 0.1 },
                },
              },
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
              wrapStrategy: "WRAP",
            },
          },
          fields:
            "userEnteredFormat(backgroundColorStyle,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
        },
      });
    }

    if (tab.frozenRowCount || tab.frozenColumnCount) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: tab.sheetId,
            gridProperties: {
              frozenRowCount: tab.frozenRowCount ?? 0,
              frozenColumnCount: tab.frozenColumnCount ?? 0,
            },
          },
          fields:
            "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        },
      });
    }

    if (tab.filter) {
      requests.push({
        setBasicFilter: {
          filter: {
            range: tab.filter,
          },
        },
      });
    }

    for (const dropdown of tab.dropdowns) {
      requests.push({
        setDataValidation: {
          range: dropdown.range,
          rule: {
            condition: {
              type: "ONE_OF_LIST",
              values: dropdown.values.map((value) => ({
                userEnteredValue: value,
              })),
            },
            strict: true,
            showCustomUi: true,
          },
        },
      });
    }

    for (const numberFormat of tab.numberFormats) {
      requests.push({
        repeatCell: {
          range: numberFormat.range,
          cell: {
            userEnteredFormat: {
              numberFormat: {
                type: numberFormat.type,
                pattern: numberFormat.pattern,
              },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      });
    }

    for (const conditionalFormat of tab.conditionalFormats) {
      requests.push(
        createConditionalFormatRequest(conditionalFormat),
      );
    }

    for (const width of tab.columnWidths) {
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId: tab.sheetId,
            dimension: "COLUMNS",
            startIndex: width.startIndex,
            endIndex: width.endIndex,
          },
          properties: {
            pixelSize: width.pixelSize,
          },
          fields: "pixelSize",
        },
      });
    }

    for (const chart of tab.charts) {
      requests.push(createChartRequest(tab.sheetId, chart));
    }
  }

  requests.push(
    createMetadataRequest(BLUEPRINT_METADATA_KEY, blueprintMarker(blueprint)),
  );

  return requests;
}

function createConditionalFormatRequest(
  conditionalFormat: SheetConditionalFormat,
) {
  const condition =
    conditionalFormat.condition === "custom_formula"
      ? {
          type: "CUSTOM_FORMULA",
          values: [{ userEnteredValue: conditionalFormat.formula }],
        }
      : {
          type:
            conditionalFormat.condition === "text_eq"
              ? "TEXT_EQ"
              : conditionalFormat.condition === "number_gte"
                ? "NUMBER_GREATER_THAN_EQ"
                : "NUMBER_LESS",
          values: [{ userEnteredValue: String(conditionalFormat.value) }],
        };

  return {
    addConditionalFormatRule: {
      rule: {
        ranges: [conditionalFormat.range],
        booleanRule: {
          condition,
          format: {
            backgroundColorStyle: {
              rgbColor: conditionalFormat.backgroundColor,
            },
          },
        },
      },
      index: 0,
    },
  };
}

function createChartRequest(targetSheetId: number, chart: SheetChartBlueprint) {
  const domain = {
    sourceRange: {
      sources: [
        {
          sheetId: chart.sourceSheetId,
          ...chart.domain,
        },
      ],
    },
  };
  const series = chart.series.map((range) => ({
    sourceRange: {
      sources: [
        {
          sheetId: chart.sourceSheetId,
          ...range,
        },
      ],
    },
  }));
  const position = {
    overlayPosition: {
      anchorCell: {
        sheetId: targetSheetId,
        rowIndex: chart.anchor.rowIndex,
        columnIndex: chart.anchor.columnIndex,
      },
      widthPixels: chart.anchor.widthPixels,
      heightPixels: chart.anchor.heightPixels,
    },
  };

  if (chart.type === "PIE") {
    return {
      addChart: {
        chart: {
          spec: {
            title: chart.title,
            fontName: "Arial",
            pieChart: {
              legendPosition: "RIGHT_LEGEND",
              domain,
              series: series[0],
              threeDimensional: false,
            },
          },
          position,
        },
      },
    };
  }

  return {
    addChart: {
      chart: {
        spec: {
          title: chart.title,
          fontName: "Arial",
          basicChart: {
            chartType: chart.type,
            legendPosition: "BOTTOM_LEGEND",
            domains: [{ domain }],
            series: series.map((sourceRange) => ({
              series: sourceRange,
              targetAxis: "LEFT_AXIS",
            })),
            headerCount: 1,
          },
        },
        position,
      },
    },
  };
}

function createMetadataRequest(key: string, value: string) {
  return {
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: key,
        metadataValue: value,
        location: {
          spreadsheet: true,
        },
        visibility: "DOCUMENT",
      },
    },
  };
}

function toCellData(value: SheetCellInput) {
  if (typeof value === "object" && value !== null && "formula" in value) {
    return {
      userEnteredValue: {
        formulaValue: value.formula,
      },
    };
  }

  return toScalarCellData(value);
}

function toScalarCellData(value: SheetScalar) {
  if (value === null) {
    return {};
  }

  if (typeof value === "number") {
    return { userEnteredValue: { numberValue: value } };
  }

  if (typeof value === "boolean") {
    return { userEnteredValue: { boolValue: value } };
  }

  return { userEnteredValue: { stringValue: value } };
}

function padRow(row: SheetCellInput[], width: number) {
  return Array.from({ length: width }, (_, index) => row[index] ?? null);
}

function resolveSheetId(spreadsheet: SpreadsheetMetadata, range: string) {
  const title = extractSheetTitle(range);
  const sheetId = spreadsheet.sheets?.find(
    (sheet) => sheet.properties?.title === title,
  )?.properties?.sheetId;

  if (typeof sheetId !== "number") {
    throw new Error(`Google Sheet tab was not found: ${title}.`);
  }

  return sheetId;
}

function extractSheetTitle(range: string) {
  const separatorIndex = range.indexOf("!");

  if (separatorIndex < 1) {
    throw new Error("Sheet range must include an explicit tab name.");
  }

  const rawTitle = range.slice(0, separatorIndex);

  return rawTitle.startsWith("'") && rawTitle.endsWith("'")
    ? rawTitle.slice(1, -1).replace(/''/g, "'")
    : rawTitle;
}

function toCreatedSpreadsheet(
  spreadsheet: SpreadsheetMetadata,
  fallbackTitle: string,
  reused: boolean,
): CreatedSpreadsheet {
  const spreadsheetId = requireString(
    spreadsheet.spreadsheetId,
    "spreadsheetId",
  );

  return {
    spreadsheetId,
    spreadsheetUrl:
      spreadsheet.spreadsheetUrl ||
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    title: spreadsheet.properties?.title || fallbackTitle,
    reused,
  };
}

function blueprintMarker(blueprint: GoogleSheetBlueprint) {
  return `${blueprint.id}:v${blueprint.version}`;
}

function hashIdempotencyKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function requireString(value: string | undefined, field: string) {
  if (!value) {
    throw new Error(`Google API response is missing ${field}.`);
  }

  return value;
}
