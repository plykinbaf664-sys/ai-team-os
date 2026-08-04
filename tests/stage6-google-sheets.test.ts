import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleAccessTokenProvider } from "../lib/integrations/google-sheets/google-auth";
import {
  buildBlueprintRequests,
  createGoogleSheetsAdapter,
  createGoogleSheetsAdapterFromEnv,
} from "../lib/integrations/google-sheets/google-sheets-adapter";
import {
  formatGoogleSheetsWorkspaceContext,
  inspectGoogleSheetsWorkspace,
} from "../lib/integrations/google-sheets/document-context";
import { executeGoogleSheetsAction } from "../lib/executors/google-sheets-executor";
import { createOwnProjectOperationsBlueprint } from "../lib/integrations/google-sheets/launch-tracker-blueprint";
import type { GoogleSheetsAdapter } from "../lib/integrations/google-sheets/types";

test("refreshes and caches a Google OAuth access token", async () => {
  let calls = 0;
  const provider = createGoogleAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    now: () => 1_000,
    fetchImplementation: (async (_input, init) => {
      calls += 1;
      assert.equal(init?.method, "POST");
      assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get("grant_type"), "refresh_token");

      return Response.json({
        access_token: "access-token",
        expires_in: 3600,
      });
    }) as typeof fetch,
  });

  assert.ok(provider);
  assert.equal(await provider(), "access-token");
  assert.equal(await provider(), "access-token");
  assert.equal(calls, 1);
});

test("finds existing spreadsheets by exact title ignoring letter case", async () => {
  const urls: string[] = [];
  const adapter = createGoogleSheetsAdapter({
    getAccessToken: async () => "access-token",
    fetchImplementation: (async (input) => {
      urls.push(String(input));

      return Response.json({
        files: [
          {
            id: "existing-1",
            name: "Финансы '2026",
            webViewLink:
              "https://docs.google.com/spreadsheets/d/existing-1/edit",
            modifiedTime: "2026-07-29T10:00:00Z",
          },
        ],
      });
    }) as typeof fetch,
  });

  const matches = await adapter.findSpreadsheetsByTitle("финансы '2026");
  const query = new URL(urls[0]).searchParams.get("q");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].spreadsheetId, "existing-1");
  assert.doesNotMatch(query || "", /name=/);
  assert.match(query || "", /mimeType=/);
  assert.match(query || "", /trashed=false/);
});

test("inspects the explicitly mentioned spreadsheet before unrelated documents", async () => {
  const metadataCalls: string[] = [];
  const adapter = fakeSheetsAdapter({
    listSpreadsheets: async () => [
      {
        spreadsheetId: "other",
        spreadsheetUrl: "https://example.com/other",
        title: "Другой проект",
        modifiedTime: "2026-07-31T12:00:00Z",
      },
      {
        spreadsheetId: "launch",
        spreadsheetUrl: "https://example.com/launch",
        title: "Запуск магазина ИИ-агентов — 90 дней",
        modifiedTime: "2026-07-30T12:00:00Z",
      },
    ],
    getSpreadsheetMetadata: async (spreadsheetId) => {
      metadataCalls.push(spreadsheetId);
      return {
        spreadsheetId,
        spreadsheetUrl: `https://example.com/${spreadsheetId}`,
        title: "Запуск магазина ИИ-агентов — 90 дней",
        tabs: [
          {
            sheetId: 1,
            title: "Рассылки",
            rowCount: 100,
            columnCount: 4,
            frozenRowCount: 1,
            frozenColumnCount: 0,
          },
        ],
      };
    },
    readRange: async ({ spreadsheetId, range }) => ({
      spreadsheetId,
      range,
      values: [
        ["Дата", "Сегмент", "Количество", "Комментарий"],
        ["29.07.2026", "Партнерский", 8, ""],
      ],
    }),
  });

  const context = await inspectGoogleSheetsWorkspace({
    adapter,
    sourceText: "Внеси 10 рассылок за 30 июля.",
    conversation: [
      {
        role: "assistant",
        text: "Работаем с таблицей Запуск магазина и агентов.",
      },
    ],
  });
  const formatted = formatGoogleSheetsWorkspaceContext(context);

  assert.deepEqual(metadataCalls, ["launch"]);
  assert.equal(context.inspectedDocuments[0].tabs[0].title, "Рассылки");
  assert.match(formatted, /Дата \| Сегмент \| Количество/);
});

test("appends through the values API instead of the physical sheet bottom", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const responses = [
    {
      spreadsheetId: "sheet-1",
      properties: { title: "Запуск" },
      sheets: [
        {
          properties: {
            sheetId: 1,
            title: "Рассылки",
            gridProperties: { rowCount: 100, columnCount: 4 },
          },
        },
      ],
      developerMetadata: [],
    },
    {
      updates: {
        updatedRange: "Рассылки!A12:D12",
      },
    },
    { replies: [] },
  ];
  const adapter = createGoogleSheetsAdapter({
    getAccessToken: async () => "access-token",
    fetchImplementation: (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : undefined,
      });
      return Response.json(responses.shift() ?? {});
    }) as typeof fetch,
  });

  const result = await adapter.appendRows({
    spreadsheetId: "sheet-1",
    range: "'Рассылки'!A:D",
    values: [["30.07.2026", "Партнерский", 10, ""]],
    idempotencyKey: "metric-1",
  });

  assert.equal(result.updatedRange, "Рассылки!A12:D12");
  assert.match(calls[1].url, /\/values\/.*:append\?/);
  assert.equal(calls[1].method, "POST");
  assert.doesNotMatch(JSON.stringify(calls[2].body), /appendCells/);
});

test("verifies an appended row by reading the returned range", async () => {
  const readRanges: string[] = [];
  const adapter = fakeSheetsAdapter({
    getSpreadsheetMetadata: async () => ({
      spreadsheetId: "launch",
      spreadsheetUrl: "https://example.com/launch",
      title: "Запуск магазина ИИ-агентов — 90 дней",
      tabs: [
        {
          sheetId: 1,
          title: "СЕГМЕНТЫ КОНТАКТОВ",
          rowCount: 100,
          columnCount: 10,
          frozenRowCount: 2,
          frozenColumnCount: 0,
        },
      ],
    }),
    appendRows: async () => ({
      updatedRange: "СЕГМЕНТЫ КОНТАКТОВ!A14:J14",
      reused: false,
    }),
    readRange: async ({ spreadsheetId, range }) => {
      readRanges.push(range);
      return {
        spreadsheetId,
        range,
        values: [
          [
            "2026-07-30",
            "Рассылка 30.07",
            "Партнёры / Консалтинг",
            null,
            null,
            "отправлено",
            10,
            null,
            null,
            "",
          ],
        ],
      };
    },
  });

  const result = await executeGoogleSheetsAction(
    {
      id: "action-1",
      type: "update_sheet",
      payload: {
        target: {
          kind: "id",
          spreadsheetId: "launch",
        },
        range: "'СЕГМЕНТЫ КОНТАКТОВ'!A:J",
        operation: "append_rows",
        values: [
          [
            "2026-07-30",
            "Рассылка 30.07",
            "Партнёры / Консалтинг",
            null,
            null,
            "отправлено",
            10,
            null,
            null,
            "",
          ],
        ],
      },
    },
    adapter,
  );

  assert.equal(result?.status, "succeeded");
  assert.equal(
    readRanges.at(-1),
    "СЕГМЕНТЫ КОНТАКТОВ!A14:J14",
  );
  assert.match(result?.message ?? "", /Проверенный диапазон/);
});

test("reads metadata and a bounded range from an existing spreadsheet", async () => {
  const urls: string[] = [];
  const responses = [
    {
      spreadsheetId: "existing-1",
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/existing-1/edit",
      properties: {
        title: "Финансы 2026",
        locale: "ru_RU",
        timeZone: "Europe/Moscow",
      },
      sheets: [
        {
          properties: {
            sheetId: 10,
            title: "Расходы",
            gridProperties: {
              rowCount: 100,
              columnCount: 8,
              frozenRowCount: 1,
            },
          },
        },
      ],
    },
    {
      spreadsheetId: "existing-1",
      properties: { title: "Финансы 2026" },
      sheets: [
        {
          properties: {
            sheetId: 10,
            title: "Расходы",
            gridProperties: { rowCount: 100, columnCount: 8 },
          },
        },
      ],
    },
    {
      range: "Расходы!A1:B2",
      values: [
        ["Категория", "Сумма"],
        ["Реклама", "1000"],
      ],
    },
  ];
  const adapter = createGoogleSheetsAdapter({
    getAccessToken: async () => "access-token",
    fetchImplementation: (async (input) => {
      urls.push(String(input));
      return Response.json(responses.shift() ?? {});
    }) as typeof fetch,
  });

  const metadata = await adapter.getSpreadsheetMetadata("existing-1");
  const range = await adapter.readRange({
    spreadsheetId: "existing-1",
    range: "Расходы!A1:B2",
  });

  assert.equal(metadata.tabs[0].title, "Расходы");
  assert.equal(metadata.tabs[0].frozenRowCount, 1);
  assert.deepEqual(range.values[1], ["Реклама", "1000"]);
  assert.match(urls[2], /valueRenderOption=FORMATTED_VALUE/);
});

test("reads formula and protected-column metadata for a sheet profile", async () => {
  const urls: string[] = [];
  const responses = [
    {
      spreadsheetId: "existing-1",
      properties: { title: "Аутрич" },
      sheets: [
        {
          properties: {
            sheetId: 10,
            title: "Сегменты",
            gridProperties: { rowCount: 100, columnCount: 4 },
          },
        },
      ],
    },
    {
      sheets: [
        {
          properties: { sheetId: 10, title: "Сегменты" },
          protectedRanges: [
            {
              range: {
                sheetId: 10,
                startRowIndex: 1,
                endRowIndex: 12,
                startColumnIndex: 1,
                endColumnIndex: 2,
              },
            },
          ],
          data: [
            {
              startRow: 10,
              startColumn: 0,
              rowData: [
                {
                  values: [
                    {},
                    {},
                    {
                      userEnteredValue: {
                        formulaValue: "=IFERROR(D2/C2;0)",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  const adapter = createGoogleSheetsAdapter({
    getAccessToken: async () => "access-token",
    fetchImplementation: (async (input) => {
      urls.push(String(input));
      return Response.json(responses.shift() ?? {});
    }) as typeof fetch,
  });

  const metadata = await adapter.readSheetGridMetadata({
    spreadsheetId: "existing-1",
    range: "'Сегменты'!A1:D12",
  });

  assert.deepEqual(metadata.formulaColumns, [2]);
  assert.deepEqual(metadata.protectedColumns, [1]);
  assert.deepEqual(metadata.formulaCells, [
    {
      rowIndex: 10,
      columnIndex: 2,
      formula: "=IFERROR(D2/C2;0)",
    },
  ]);
  assert.deepEqual(metadata.protectedRanges, [
    {
      startRowIndex: 1,
      endRowIndex: 12,
      startColumnIndex: 1,
      endColumnIndex: 2,
    },
  ]);
  assert.match(urls[1], /includeGridData=true/);
  assert.match(urls[1], /ranges=/);
});

test("rejects unbounded reads before requesting cell values", async () => {
  let calls = 0;
  const adapter = createGoogleSheetsAdapter({
    getAccessToken: async () => "access-token",
    fetchImplementation: (async () => {
      calls += 1;
      return Response.json({
        spreadsheetId: "existing-1",
        properties: { title: "Финансы 2026" },
        sheets: [
          {
            properties: {
              sheetId: 10,
              title: "Расходы",
              gridProperties: { rowCount: 100, columnCount: 8 },
            },
          },
        ],
      });
    }) as typeof fetch,
  });

  await assert.rejects(
    adapter.readRange({
      spreadsheetId: "existing-1",
      range: "Расходы!A:A",
    }),
    /must be bounded/,
  );
  assert.equal(calls, 1);
});

test("builds a complete own-project operations blueprint", () => {
  const blueprint = createOwnProjectOperationsBlueprint(
    "Мой проект",
    "Europe/Moscow",
  );

  assert.equal(blueprint.tabs.length, 3);
  assert.deepEqual(
    blueprint.tabs.map((tab) => tab.title),
    ["Задачи", "Метрики", "Дашборд"],
  );
  assert.equal(blueprint.tabs[0].dropdowns.length, 2);
  assert.equal(blueprint.tabs[2].charts.length, 2);
  assert.equal(blueprint.timeZone, "Europe/Moscow");
  assert.equal(blueprint.version, 2);
  assert.equal(blueprint.tabs[2].hideGridlines, true);
  assert.ok(blueprint.tabs.every((tab) => tab.styles.length > 0));
  assert.ok(blueprint.tabs.every((tab) => tab.borders.length > 0));
});

test("compiles blueprint into valid single-operation batch requests", () => {
  const requests = buildBlueprintRequests(
    createOwnProjectOperationsBlueprint("Мой проект", "Europe/Moscow"),
  ) as Array<Record<string, unknown>>;
  const requestTypes = requests.map((request) => Object.keys(request));

  assert.ok(requestTypes.every((keys) => keys.length === 1));
  assert.ok(requestTypes.some((keys) => keys[0] === "updateCells"));
  assert.ok(requestTypes.some((keys) => keys[0] === "setBasicFilter"));
  assert.ok(requestTypes.some((keys) => keys[0] === "setDataValidation"));
  assert.ok(requestTypes.some((keys) => keys[0] === "mergeCells"));
  assert.ok(requestTypes.some((keys) => keys[0] === "addBanding"));
  assert.ok(requestTypes.some((keys) => keys[0] === "updateBorders"));
  assert.ok(
    requestTypes.some((keys) => keys[0] === "addConditionalFormatRule"),
  );
  assert.equal(
    requestTypes.filter((keys) => keys[0] === "addChart").length,
    2,
  );
  assert.equal(
    requestTypes.at(-1)?.[0],
    "createDeveloperMetadata",
  );
  assert.match(JSON.stringify(requests), /IFERROR\(D4\/C4;0\)/);
  assert.match(
    JSON.stringify(requests),
    /AND\(\$C4<TODAY\(\);\$C4<>\\"\\";\$E4<>\\"Готово\\"\)/,
  );
  assert.match(JSON.stringify(requests), /\$F4<0,8/);
  assert.match(JSON.stringify(requests), /ARRAYFORMULA/);
  assert.match(JSON.stringify(requests), /hideGridlines/);
});

test("compiles supported person and Drive file smart chips", () => {
  const blueprint = createOwnProjectOperationsBlueprint(
    "Мой проект",
    "Europe/Moscow",
  );
  blueprint.tabs[0].values.push({
    startRowIndex: 210,
    startColumnIndex: 0,
    rows: [
      [
        {
          chip: {
            type: "person",
            email: "owner@example.com",
          },
        },
        {
          chip: {
            type: "drive_file",
            uri: "https://drive.google.com/file/d/file-id/view",
          },
        },
      ],
    ],
  });

  const requests = buildBlueprintRequests(blueprint);
  const serialized = JSON.stringify(requests);

  assert.match(serialized, /chipRuns/);
  assert.match(serialized, /personProperties/);
  assert.match(serialized, /richLinkProperties/);
  assert.match(serialized, /owner@example\.com/);
});

test("creates and marks a spreadsheet idempotently", async () => {
  const calls: Array<{
    url: string;
    method: string;
    body?: unknown;
  }> = [];
  const responses = [
    { files: [] },
    {
      spreadsheetId: "sheet-123",
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/sheet-123/edit",
      properties: { title: "Мой проект" },
    },
    { id: "sheet-123" },
    { replies: [] },
    { id: "sheet-123" },
  ];
  const adapter = createGoogleSheetsAdapter({
    getAccessToken: async () => "access-token",
    fetchImplementation: (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method || "GET",
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : undefined,
      });

      return Response.json(responses.shift() ?? {});
    }) as typeof fetch,
  });

  const result = await adapter.createSpreadsheet(
    createOwnProjectOperationsBlueprint("Мой проект", "Europe/Moscow"),
    "request-1",
  );

  assert.equal(result.spreadsheetId, "sheet-123");
  assert.equal(result.reused, false);
  assert.equal(calls.length, 5);
  assert.match(calls[0].url, /drive\/v3\/files/);
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].url, /sheets\.googleapis\.com\/v4\/spreadsheets$/);
  assert.match(calls[3].url, /:batchUpdate$/);
  assert.deepEqual(
    (calls[2].body as { appProperties: Record<string, string> })
      .appProperties.ai_team_os_state,
    "creating",
  );
  assert.deepEqual(
    (calls[4].body as { appProperties: Record<string, string> })
      .appProperties.ai_team_os_state,
    "complete",
  );
});

test("reuses a spreadsheet with an applied blueprint marker", async () => {
  const urls: string[] = [];
  const responses = [
    {
      files: [
        {
          id: "sheet-existing",
          appProperties: {
            ai_team_os_state: "complete",
          },
        },
      ],
    },
    {
      spreadsheetId: "sheet-existing",
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/sheet-existing/edit",
      properties: { title: "Мой проект" },
      developerMetadata: [
        {
          metadataKey: "ai_team_os_blueprint",
          metadataValue: "own-project-operations-v2:v2",
        },
      ],
    },
    { id: "sheet-existing" },
  ];
  const adapter = createGoogleSheetsAdapter({
    getAccessToken: async () => "access-token",
    fetchImplementation: (async (input) => {
      urls.push(String(input));
      return Response.json(responses.shift() ?? {});
    }) as typeof fetch,
  });

  const result = await adapter.createSpreadsheet(
    createOwnProjectOperationsBlueprint("Мой проект", "Europe/Moscow"),
    "request-1",
  );

  assert.equal(result.reused, true);
  assert.equal(urls.length, 3);
  assert.ok(!urls.some((url) => url.endsWith(":batchUpdate")));
});

test(
  "live Drive search resolves a spoken lowercase sheet title",
  { skip: process.env.RUN_LIVE_GOOGLE_TEST !== "1" },
  async () => {
    const adapter = createGoogleSheetsAdapterFromEnv();
    assert.ok(adapter);

    const matches = await adapter.findSpreadsheetsByTitle("мои материалы");

    assert.ok(
      matches.some(
        (match) =>
          match.title.localeCompare("Мои материалы", undefined, {
            sensitivity: "base",
          }) === 0,
      ),
    );
  },
);

function fakeSheetsAdapter(
  overrides: Partial<GoogleSheetsAdapter> = {},
): GoogleSheetsAdapter {
  return {
    createSpreadsheet: async () => {
      throw new Error("Not implemented in test.");
    },
    findSpreadsheetsByTitle: async () => [],
    listSpreadsheets: async () => [],
    getSpreadsheetMetadata: async () => {
      throw new Error("Not implemented in test.");
    },
    readRange: async () => {
      throw new Error("Not implemented in test.");
    },
    readSheetGridMetadata: async () => ({
      spreadsheetId: "test",
      sheetId: 1,
      sheetName: "Test",
      formulaColumns: [],
      protectedColumns: [],
    }),
    createSheetTab: async () => ({ sheetId: 1, reused: false }),
    appendRows: async () => ({ reused: false }),
    updateCells: async () => undefined,
    clearRange: async () => undefined,
    ...overrides,
  };
}
