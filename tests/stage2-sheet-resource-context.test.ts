import assert from "node:assert/strict";
import test from "node:test";
import { executeGoogleSheetsAction } from "../lib/executors/google-sheets-executor";
import {
  buildSheetProfile,
} from "../lib/integrations/google-sheets/sheet-profile";
import {
  buildSheetRowEntities,
  isUnambiguousRowMatch,
  matchSheetRows,
} from "../lib/integrations/google-sheets/row-matcher";
import type {
  ExistingSpreadsheetMetadata,
  GoogleSheetsAdapter,
  SheetScalar,
} from "../lib/integrations/google-sheets/types";

const SPREADSHEET: ExistingSpreadsheetMetadata = {
  spreadsheetId: "launch",
  spreadsheetUrl: "https://example.com/launch",
  title: "Запуск магазина ИИ-агентов — 90 дней",
  tabs: [
    {
      sheetId: 7,
      title: "ОФФЕРЫ И РАССЫЛКИ",
      rowCount: 100,
      columnCount: 12,
      frozenRowCount: 2,
      frozenColumnCount: 0,
    },
  ],
};

const VALUES: SheetScalar[][] = [
  ["Стратегия партнёрского аутрича"],
  [
    "Сегмент",
    "Оффер и результат",
    "Первое сообщение",
    "Повторное сообщение",
    "Техническая реализация",
    "План отправок",
    "Фактические отправки",
    "Ответы",
    "Интервью",
    "Обсуждения пилота",
    "Конверсия ответов",
    "Статус и комментарий",
  ],
  [
    "Партнёры / Agentic Sprint",
    "Аудит процессов",
    "Стратегический текст",
    "Follow-up через 3 дня",
    "Отправка вручную",
    30,
    10,
    1,
    0,
    0,
    0.1,
    "В работе",
  ],
];

test("builds a semantic profile and protects formulas and strategy", () => {
  const profile = buildProfile(VALUES);

  assert.equal(profile.headerRowNumber, 2);
  assert.equal(profile.entityType, "outreach_segment");
  assert.deepEqual(profile.keyColumns, ["segment", "offer_result"]);
  assert.ok(profile.metricColumns.includes("actual_sends"));
  assert.ok(profile.formulaColumns.includes("reply_conversion"));
  assert.ok(profile.protectedColumns.includes("first_message"));
  assert.ok(profile.protectedColumns.includes("technical_implementation"));
  assert.equal(
    profile.columns.find(
      (column) => column.semanticKey === "actual_sends",
    )?.updatePolicy,
    "increment",
  );
});

test("classifies operational dates before generic follow-up text", () => {
  const values: SheetScalar[][] = [
    ["Сегмент", "Дата follow-up", "Следующее действие", "Дедлайн"],
    ["Партнёры", "13.08.2026", "Провести созвон", "14.08.2026"],
  ];
  const profile = buildProfile(values);

  assert.deepEqual(
    profile.columns.map((column) => column.semanticKey),
    ["segment", "follow_up_at", "next_action", "due_date"],
  );
});

test("recognizes a contact register and keeps operational fields writable", () => {
  const values: SheetScalar[][] = [
    ["Карточки интервью"],
    [],
    [
      "Компания",
      "Сегмент",
      "Имя",
      "Должность",
      "Источник контакта",
      "Дата первого сообщения",
      "Дата следующего контакта",
      "Статус",
      "Дата интервью",
      "Текущий процесс",
      "Основная проблема",
      "Частота проблемы",
    ],
    [null, null, "Марина", null, "https://example.com/marina", null, null, "Новый", null, null, null, null],
  ];
  const profile = buildProfile(values);

  assert.equal(profile.entityType, "contact_record");
  assert.deepEqual(profile.keyColumns, ["name", "source_contact"]);
  assert.equal(column(profile, "next_contact_at").isProtected, false);
  assert.equal(column(profile, "next_contact_at").updatePolicy, "replace");
  assert.equal(column(profile, "interview_at").isProtected, false);
  assert.equal(column(profile, "interview_at").updatePolicy, "replace");
  assert.equal(column(profile, "current_process").isProtected, false);
  assert.equal(column(profile, "current_process").updatePolicy, "append_text");
});

test("matches the existing outreach row without inventing an entity", () => {
  const profile = buildProfile(VALUES);
  const entities = buildSheetRowEntities(profile, VALUES);
  const matches = matchSheetRows(
    "Сегодня сделал 10 партнёрских рассылок по Agentic Sprint",
    entities,
  );

  assert.equal(entities.length, 1);
  assert.equal(matches[0].entity.rowNumber, 3);
  assert.ok(matches[0].confidence >= 0.78);
  assert.equal(isUnambiguousRowMatch(matches, profile), true);
});

test("keeps equal partner segment matches ambiguous", () => {
  const values = [
    ...VALUES,
    [
      "Партнёры / Аудит",
      "Партнёрский аудит",
      "",
      "",
      "",
      30,
      0,
      0,
      0,
      0,
      null,
      "Не начато",
    ],
  ];
  const profile = buildProfile(values);
  const matches = matchSheetRows(
    "Сделал 10 партнёрских рассылок",
    buildSheetRowEntities(profile, values),
  );

  assert.equal(matches.length, 2);
  assert.equal(isUnambiguousRowMatch(matches, profile), false);
});

test("blocks append when an existing entity row is confidently matched", async () => {
  let appendCalls = 0;
  const adapter = fakeAdapter({
    appendRows: async () => {
      appendCalls += 1;
      return { reused: false };
    },
  });
  const result = await executeGoogleSheetsAction(
    {
      id: "action-1",
      type: "update_sheet",
      payload: {
        target: { kind: "id", spreadsheetId: "launch" },
        range: "'ОФФЕРЫ И РАССЫЛКИ'!A:L",
        operation: "append_rows",
        values: [
          [
            "Партнёры / Agentic Sprint",
            "Аудит процессов",
            null,
            null,
            null,
            null,
            10,
            null,
            null,
            null,
            null,
            null,
          ],
        ],
      },
    },
    adapter,
  );

  assert.equal(result?.status, "needs_clarification");
  assert.match(result?.message ?? "", /дубль/);
  assert.equal(appendCalls, 0);
});

test("blocks automatic updates of protected strategic columns", async () => {
  let updateCalls = 0;
  const adapter = fakeAdapter({
    updateCells: async () => {
      updateCalls += 1;
    },
  });
  const result = await executeGoogleSheetsAction(
    {
      id: "action-1",
      type: "update_sheet",
      payload: {
        target: { kind: "id", spreadsheetId: "launch" },
        range: "'ОФФЕРЫ И РАССЫЛКИ'!C3:C3",
        operation: "update_cells",
        values: [["Новый стратегический текст"]],
      },
    },
    adapter,
  );

  assert.equal(result?.status, "needs_confirmation");
  assert.match(result?.message ?? "", /защищена/);
  assert.equal(updateCalls, 0);
});

function buildProfile(values: SheetScalar[][]) {
  return buildSheetProfile({
    spreadsheet: SPREADSHEET,
    tab: SPREADSHEET.tabs[0],
    values,
    gridMetadata: {
      spreadsheetId: "launch",
      sheetId: 7,
      sheetName: "ОФФЕРЫ И РАССЫЛКИ",
      formulaColumns: [10],
      protectedColumns: [2, 3, 4],
    },
  });
}

function column(
  profile: ReturnType<typeof buildProfile>,
  semanticKey: string,
) {
  const result = profile.columns.find(
    (candidate) => candidate.semanticKey === semanticKey,
  );
  assert.ok(result, `Missing column ${semanticKey}`);
  return result;
}

function fakeAdapter(
  overrides: Partial<GoogleSheetsAdapter> = {},
): GoogleSheetsAdapter {
  return {
    createSpreadsheet: async () => {
      throw new Error("Not implemented in test.");
    },
    findSpreadsheetsByTitle: async () => [],
    listSpreadsheets: async () => [],
    getSpreadsheetMetadata: async () => SPREADSHEET,
    readRange: async ({ spreadsheetId, range }) => ({
      spreadsheetId,
      range,
      values: VALUES,
    }),
    readSheetGridMetadata: async () => ({
      spreadsheetId: "launch",
      sheetId: 7,
      sheetName: "ОФФЕРЫ И РАССЫЛКИ",
      formulaColumns: [10],
      protectedColumns: [2, 3, 4],
    }),
    createSheetTab: async () => ({ sheetId: 1, reused: false }),
    appendRows: async () => ({ reused: false }),
    updateCells: async () => undefined,
    clearRange: async () => undefined,
    ...overrides,
  };
}
