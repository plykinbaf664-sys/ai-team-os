import { createHash } from "node:crypto";
import { createGoogleAccessTokenProvider } from "./google-auth";
import type {
  CreatedSpreadsheet,
  ExistingSpreadsheetMetadata,
  ExistingSpreadsheetSummary,
  GoogleSheetBlueprint,
  GoogleSheetsAdapter,
  SheetBorderBlueprint,
  SheetCellInput,
  SheetChartBlueprint,
  SheetConditionalFormat,
  SheetGridMetadata,
  SheetScalar,
} from "./types";

type FetchImplementation = typeof fetch;

type SpreadsheetMetadata = {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: {
    title?: string;
    locale?: string;
    timeZone?: string;
  };
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
      gridProperties?: {
        rowCount?: number;
        columnCount?: number;
        frozenRowCount?: number;
        frozenColumnCount?: number;
      };
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
  modifiedTime?: string;
  appProperties?: Record<string, string>;
};

type DriveListResponse = {
  files?: DriveFile[];
  nextPageToken?: string;
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

type ValueRangeResponse = {
  range?: string;
  values?: unknown[][];
};

type AppendValuesResponse = {
  updates?: {
    updatedRange?: string;
  };
};

type SpreadsheetGridMetadataResponse = {
  sheets?: Array<{
    properties?: {
      sheetId?: number;
      title?: string;
      gridProperties?: {
        columnCount?: number;
      };
    };
    protectedRanges?: Array<{
      range?: {
        sheetId?: number;
        startRowIndex?: number;
        endRowIndex?: number;
        startColumnIndex?: number;
        endColumnIndex?: number;
      };
    }>;
    data?: Array<{
      startRow?: number;
      startColumn?: number;
      rowData?: Array<{
        values?: Array<{
          userEnteredValue?: {
            formulaValue?: string;
          };
        }>;
      }>;
    }>;
  }>;
};

const SHEETS_API = "https://sheets.googleapis.com/v4";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const BLUEPRINT_METADATA_KEY = "ai_team_os_blueprint";
const ACTION_METADATA_KEY = "ai_team_os_action";
const MAX_READ_CELLS = 500;

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
      "properties(title,locale,timeZone)",
      "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)))",
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

  async function listExistingSpreadsheets() {
    const query = [
      `mimeType='${SPREADSHEET_MIME_TYPE}'`,
      "trashed=false",
    ].join(" and ");
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const parameters = new URLSearchParams({
        q: query,
        corpora: "user",
        spaces: "drive",
        pageSize: "1000",
        orderBy: "modifiedTime desc",
        fields: "nextPageToken,files(id,name,webViewLink,modifiedTime)",
      });

      if (pageToken) {
        parameters.set("pageToken", pageToken);
      }

      const result = await requestJson<DriveListResponse>(
        `${DRIVE_API}/files?${parameters.toString()}`,
      );

      files.push(...(result.files ?? []));
      pageToken = result.nextPageToken;
    } while (pageToken);

    return files
      .filter(
        (file) =>
          typeof file.id === "string" &&
          typeof file.name === "string",
      )
      .map(toExistingSpreadsheetSummary);
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

    async findSpreadsheetsByTitle(title) {
      const normalizedTitle = title.trim();

      if (!normalizedTitle) {
        throw new Error("Google Sheet title is required.");
      }

      return (await listExistingSpreadsheets())
        .filter(
          (file) =>
            file.title.localeCompare(normalizedTitle, undefined, {
              sensitivity: "base",
            }) === 0,
        );
    },

    async listSpreadsheets() {
      return listExistingSpreadsheets();
    },

    async getSpreadsheetMetadata(spreadsheetId) {
      return toExistingSpreadsheetMetadata(
        await getSpreadsheet(spreadsheetId),
      );
    },

    async readRange({ spreadsheetId, range }) {
      const spreadsheet = await getSpreadsheet(spreadsheetId);
      resolveSheetId(spreadsheet, range);
      assertBoundedRange(range, MAX_READ_CELLS);

      const parameters = new URLSearchParams({
        majorDimension: "ROWS",
        valueRenderOption: "FORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      });
      const result = await requestJson<ValueRangeResponse>(
        `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${parameters.toString()}`,
      );

      return {
        spreadsheetId,
        range: result.range || range,
        values: normalizeSheetValues(result.values),
      };
    },

    async readSheetGridMetadata({ spreadsheetId, range }) {
      const spreadsheet = await getSpreadsheet(spreadsheetId);
      const sheetId = resolveSheetId(spreadsheet, range);
      const sheet = spreadsheet.sheets?.find(
        (candidate) => candidate.properties?.sheetId === sheetId,
      );
      const parameters = new URLSearchParams({
        includeGridData: "true",
        ranges: range,
        fields: [
          "sheets(properties(sheetId,title,gridProperties(columnCount))",
          "protectedRanges(range(sheetId,startRowIndex,endRowIndex,startColumnIndex,endColumnIndex))",
          "data(startRow,startColumn,rowData(values(userEnteredValue(formulaValue)))))",
        ].join(","),
      });
      const result = await requestJson<SpreadsheetGridMetadataResponse>(
        `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}?${parameters.toString()}`,
      );
      const resultSheet = result.sheets?.find(
        (candidate) => candidate.properties?.sheetId === sheetId,
      );

      return toSheetGridMetadata({
        spreadsheetId,
        sheetId,
        sheetName:
          resultSheet?.properties?.title ??
          sheet?.properties?.title ??
          "",
        sheet: resultSheet,
      });
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
        return { reused: true };
      }

      resolveSheetId(spreadsheet, range);
      const parameters = new URLSearchParams({
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
      });
      const appendResult = await requestJson<AppendValuesResponse>(
        `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${parameters.toString()}`,
        {
          method: "POST",
          body: JSON.stringify({
            range,
            majorDimension: "ROWS",
            values,
          }),
        },
      );

      await requestJson<BatchUpdateResponse>(
        `${SHEETS_API}/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        {
          method: "POST",
          body: JSON.stringify({
            requests: [
              createMetadataRequest(ACTION_METADATA_KEY, marker),
            ],
          }),
        },
      );

      return {
        updatedRange: appendResult.updates?.updatedRange,
        reused: false,
      };
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
          fields: "userEnteredValue,chipRuns",
        },
      });
    }

    for (const merge of tab.merges) {
      requests.push({
        mergeCells: {
          range: merge.range,
          mergeType: merge.type,
        },
      });
    }

    for (const bandedRange of tab.bandedRanges) {
      requests.push({
        addBanding: {
          bandedRange: {
            range: bandedRange.range,
            rowProperties: {
              ...(bandedRange.headerColor
                ? {
                    headerColorStyle: {
                      rgbColor: bandedRange.headerColor,
                    },
                  }
                : {}),
              firstBandColorStyle: {
                rgbColor: bandedRange.firstBandColor,
              },
              secondBandColorStyle: {
                rgbColor: bandedRange.secondBandColor,
              },
            },
          },
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

    for (const style of tab.styles) {
      const userEnteredFormat: Record<string, unknown> = {};
      const fields: string[] = [];

      if (style.backgroundColor) {
        userEnteredFormat.backgroundColorStyle = {
          rgbColor: style.backgroundColor,
        };
        fields.push("backgroundColorStyle");
      }

      if (
        style.foregroundColor ||
        style.bold !== undefined ||
        style.fontSize !== undefined
      ) {
        userEnteredFormat.textFormat = {
          ...(style.foregroundColor
            ? {
                foregroundColorStyle: {
                  rgbColor: style.foregroundColor,
                },
              }
            : {}),
          ...(style.bold !== undefined ? { bold: style.bold } : {}),
          ...(style.fontSize !== undefined
            ? { fontSize: style.fontSize }
            : {}),
        };
        fields.push("textFormat");
      }

      for (const property of [
        "horizontalAlignment",
        "verticalAlignment",
        "wrapStrategy",
      ] as const) {
        if (style[property] !== undefined) {
          userEnteredFormat[property] = style[property];
          fields.push(property);
        }
      }

      if (fields.length) {
        requests.push({
          repeatCell: {
            range: style.range,
            cell: { userEnteredFormat },
            fields: `userEnteredFormat(${fields.join(",")})`,
          },
        });
      }
    }

    if (
      tab.frozenRowCount ||
      tab.frozenColumnCount ||
      tab.tabColor ||
      tab.hideGridlines !== undefined
    ) {
      const sheetFields: string[] = [];
      const properties: Record<string, unknown> = {
        sheetId: tab.sheetId,
      };

      if (tab.frozenRowCount || tab.frozenColumnCount) {
        properties.gridProperties = {
          frozenRowCount: tab.frozenRowCount ?? 0,
          frozenColumnCount: tab.frozenColumnCount ?? 0,
          ...(tab.hideGridlines !== undefined
            ? { hideGridlines: tab.hideGridlines }
            : {}),
        };
        sheetFields.push(
          "gridProperties.frozenRowCount",
          "gridProperties.frozenColumnCount",
        );

        if (tab.hideGridlines !== undefined) {
          sheetFields.push("gridProperties.hideGridlines");
        }
      } else if (tab.hideGridlines !== undefined) {
        properties.gridProperties = {
          hideGridlines: tab.hideGridlines,
        };
        sheetFields.push("gridProperties.hideGridlines");
      }

      if (tab.tabColor) {
        properties.tabColorStyle = {
          rgbColor: tab.tabColor,
        };
        sheetFields.push("tabColorStyle");
      }

      requests.push({
        updateSheetProperties: {
          properties,
          fields: sheetFields.join(","),
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

    for (const border of tab.borders) {
      requests.push(createBorderRequest(border));
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

    for (const height of tab.rowHeights) {
      requests.push({
        updateDimensionProperties: {
          range: {
            sheetId: tab.sheetId,
            dimension: "ROWS",
            startIndex: height.startIndex,
            endIndex: height.endIndex,
          },
          properties: {
            pixelSize: height.pixelSize,
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

function createBorderRequest(border: SheetBorderBlueprint) {
  const edge = {
    style: border.style,
    colorStyle: {
      rgbColor: border.color,
    },
  };

  return {
    updateBorders: {
      range: border.range,
      ...(border.outer
        ? {
            top: edge,
            bottom: edge,
            left: edge,
            right: edge,
          }
        : {}),
      ...(border.innerHorizontal ? { innerHorizontal: edge } : {}),
      ...(border.innerVertical ? { innerVertical: edge } : {}),
    },
  };
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

  if (typeof value === "object" && value !== null && "chip" in value) {
    const chip =
      value.chip.type === "person"
        ? {
            personProperties: {
              email: value.chip.email,
              displayFormat: value.chip.displayFormat ?? "DEFAULT",
            },
          }
        : {
            richLinkProperties: {
              uri: value.chip.uri,
            },
          };

    return {
      userEnteredValue: {
        stringValue: "@",
      },
      chipRuns: [
        {
          startIndex: 0,
          chip,
        },
      ],
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

function toExistingSpreadsheetSummary(
  file: DriveFile,
): ExistingSpreadsheetSummary {
  const spreadsheetId = requireString(file.id, "file.id");

  return {
    spreadsheetId,
    spreadsheetUrl:
      file.webViewLink ||
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    title: requireString(file.name, "file.name"),
    modifiedTime: file.modifiedTime,
  };
}

function toExistingSpreadsheetMetadata(
  spreadsheet: SpreadsheetMetadata,
): ExistingSpreadsheetMetadata {
  const spreadsheetId = requireString(
    spreadsheet.spreadsheetId,
    "spreadsheetId",
  );

  return {
    spreadsheetId,
    spreadsheetUrl:
      spreadsheet.spreadsheetUrl ||
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    title: requireString(spreadsheet.properties?.title, "properties.title"),
    locale: spreadsheet.properties?.locale,
    timeZone: spreadsheet.properties?.timeZone,
    tabs: (spreadsheet.sheets ?? []).map((sheet) => {
      const properties = sheet.properties;

      if (typeof properties?.sheetId !== "number") {
        throw new Error("Google API response is missing sheetId.");
      }

      return {
        sheetId: properties.sheetId,
        title: requireString(properties.title, "sheet.properties.title"),
        rowCount: properties.gridProperties?.rowCount ?? 0,
        columnCount: properties.gridProperties?.columnCount ?? 0,
        frozenRowCount: properties.gridProperties?.frozenRowCount ?? 0,
        frozenColumnCount: properties.gridProperties?.frozenColumnCount ?? 0,
      };
    }),
  };
}

function normalizeSheetValues(values: unknown[][] | undefined): SheetScalar[][] {
  return (values ?? []).map((row) =>
    row.map((value) => {
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return value;
      }

      return String(value);
    }),
  );
}

function toSheetGridMetadata({
  spreadsheetId,
  sheetId,
  sheetName,
  sheet,
}: {
  spreadsheetId: string;
  sheetId: number;
  sheetName: string;
  sheet: NonNullable<SpreadsheetGridMetadataResponse["sheets"]>[number] | undefined;
}): SheetGridMetadata {
  const formulaColumns = new Set<number>();
  const protectedColumns = new Set<number>();
  const formulaCells: NonNullable<SheetGridMetadata["formulaCells"]> = [];
  const protectedRanges: NonNullable<SheetGridMetadata["protectedRanges"]> = [];

  for (const data of sheet?.data ?? []) {
    const startRow = data.startRow ?? 0;
    const startColumn = data.startColumn ?? 0;

    for (const [rowOffset, row] of (data.rowData ?? []).entries()) {
      for (const [offset, cell] of (row.values ?? []).entries()) {
        const formula = cell.userEnteredValue?.formulaValue;
        if (formula) {
          const columnIndex = startColumn + offset;
          formulaColumns.add(columnIndex);
          formulaCells.push({
            rowIndex: startRow + rowOffset,
            columnIndex,
            formula,
          });
        }
      }
    }
  }

  for (const protectedRange of sheet?.protectedRanges ?? []) {
    const range = protectedRange.range;

    if (range?.sheetId !== undefined && range.sheetId !== sheetId) {
      continue;
    }

    const start = range?.startColumnIndex ?? 0;
    const end =
      range?.endColumnIndex ??
      sheet?.properties?.gridProperties?.columnCount ??
      start + 1;

    for (let index = start; index < end; index += 1) {
      protectedColumns.add(index);
    }
    protectedRanges.push({
      ...(range?.startRowIndex !== undefined
        ? { startRowIndex: range.startRowIndex }
        : {}),
      ...(range?.endRowIndex !== undefined
        ? { endRowIndex: range.endRowIndex }
        : {}),
      ...(range?.startColumnIndex !== undefined
        ? { startColumnIndex: range.startColumnIndex }
        : {}),
      ...(range?.endColumnIndex !== undefined
        ? { endColumnIndex: range.endColumnIndex }
        : {}),
    });
  }

  return {
    spreadsheetId,
    sheetId,
    sheetName,
    formulaColumns: [...formulaColumns].sort((left, right) => left - right),
    protectedColumns: [...protectedColumns].sort(
      (left, right) => left - right,
    ),
    formulaCells,
    protectedRanges,
  };
}

function assertBoundedRange(range: string, maxCells: number) {
  const separatorIndex = range.indexOf("!");

  if (separatorIndex < 1) {
    throw new Error("Sheet range must include an explicit tab name.");
  }

  const cellRange = range.slice(separatorIndex + 1);
  const match = cellRange.match(
    /^\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i,
  );

  if (!match) {
    throw new Error(
      "Sheet read range must be bounded, for example 'Лист 1'!A1:D20.",
    );
  }

  const startColumn = columnToIndex(match[1]);
  const startRow = Number(match[2]);
  const endColumn = columnToIndex(match[3] || match[1]);
  const endRow = Number(match[4] || match[2]);

  if (
    startColumn > endColumn ||
    startRow > endRow ||
    startRow < 1 ||
    endRow < 1
  ) {
    throw new Error("Sheet read range is invalid.");
  }

  const cellCount =
    (endColumn - startColumn + 1) * (endRow - startRow + 1);

  if (cellCount > maxCells) {
    throw new Error(
      `Sheet read range is too large: ${cellCount} cells; maximum is ${maxCells}.`,
    );
  }
}

function columnToIndex(column: string) {
  return [...column.toUpperCase()].reduce(
    (result, character) => result * 26 + character.charCodeAt(0) - 64,
    0,
  );
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
