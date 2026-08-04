import assert from "node:assert/strict";
import test from "node:test";
import { executeContextAwareSheetUpdate } from "../lib/executors/context-aware-sheet-executor";
import type {
  ExistingSpreadsheetMetadata,
  GoogleSheetsAdapter,
  SheetGridMetadata,
  SheetScalar,
} from "../lib/integrations/google-sheets/types";

const metadata: ExistingSpreadsheetMetadata = {
  spreadsheetId: "launch-sheet",
  spreadsheetUrl: "https://example.com/launch-sheet",
  title: "Запуск магазина ИИ-агентов — 90 дней",
  tabs: [
    {
      sheetId: 1,
      title: "ОФФЕРЫ И РАССЫЛКИ",
      rowCount: 100,
      columnCount: 12,
      frozenRowCount: 3,
      frozenColumnCount: 0,
    },
  ],
};

test("updates one static metric cell and verifies the result", async () => {
  const state = fakeState(3);
  const result = await executeContextAwareSheetUpdate({
    action: updateAction("I11", 13),
    adapter: state.adapter,
    metadata,
  });

  assert.equal(result?.status, "succeeded");
  assert.equal(state.value(), 13);
  assert.equal(state.updateCalls(), 1);
  assert.match(result?.message ?? "", /3 → 13/);
});

test("treats the same final value as an idempotent no-op", async () => {
  const state = fakeState(13);
  const result = await executeContextAwareSheetUpdate({
    action: updateAction("I11", 13),
    adapter: state.adapter,
    metadata,
  });

  assert.equal(result?.status, "succeeded");
  assert.equal(state.updateCalls(), 0);
  assert.match(result?.message ?? "", /Повторная запись не потребовалась/);
});

test("does not overwrite a formula in the exact target cell", async () => {
  const state = fakeState(3, {
    targetGrid: {
      ...emptyGrid(),
      formulaColumns: [8],
      formulaCells: [
        {
          rowIndex: 10,
          columnIndex: 8,
          formula: "=SUM('ЖУРНАЛ'!I:I)",
        },
      ],
    },
  });
  const result = await executeContextAwareSheetUpdate({
    action: updateAction("I11", 13),
    adapter: state.adapter,
    metadata,
  });

  assert.equal(result?.status, "needs_clarification");
  assert.equal(result?.errorCode, "sheet_formula_source_required");
  assert.equal(state.updateCalls(), 0);
});

test("keeps strategic text protected", async () => {
  const state = fakeState("Первоначальный текст", {
    targetGrid: {
      ...emptyGrid(),
      protectedColumns: [4],
      protectedRanges: [
        {
          startRowIndex: 3,
          endRowIndex: 100,
          startColumnIndex: 4,
          endColumnIndex: 5,
        },
      ],
    },
  });
  const result = await executeContextAwareSheetUpdate({
    action: updateAction("E11", "Новый текст"),
    adapter: state.adapter,
    metadata,
  });

  assert.equal(result?.status, "needs_confirmation");
  assert.equal(state.updateCalls(), 0);
});

test("fails when post-write verification does not match", async () => {
  const state = fakeState(3, { ignoreWrites: true });
  const result = await executeContextAwareSheetUpdate({
    action: updateAction("I11", 13),
    adapter: state.adapter,
    metadata,
  });

  assert.equal(result?.status, "failed");
  assert.equal(result?.errorCode, "sheet_write_verification_failed");
});

test("leaves multi-cell updates to the existing bulk safety path", async () => {
  const state = fakeState(3);
  const action = updateAction("I11:I12", 13);
  const result = await executeContextAwareSheetUpdate({
    action,
    adapter: state.adapter,
    metadata,
  });

  assert.equal(result, null);
  assert.equal(state.updateCalls(), 0);
});

function updateAction(cell: string, value: SheetScalar) {
  return {
    id: "action-1",
    type: "update_sheet" as const,
    payload: {
      target: { kind: "id" as const, spreadsheetId: "launch-sheet" },
      range: `'ОФФЕРЫ И РАССЫЛКИ'!${cell}`,
      operation: "update_cells" as const,
      values: [[value]],
    },
  };
}

function fakeState(
  initialValue: SheetScalar,
  {
    targetGrid = emptyGrid(),
    ignoreWrites = false,
  }: {
    targetGrid?: SheetGridMetadata;
    ignoreWrites?: boolean;
  } = {},
) {
  let value = initialValue;
  let updateCalls = 0;
  const adapter: GoogleSheetsAdapter = {
    createSpreadsheet: async () => {
      throw new Error("Not implemented in test.");
    },
    findSpreadsheetsByTitle: async () => [],
    listSpreadsheets: async () => [],
    getSpreadsheetMetadata: async () => metadata,
    readRange: async ({ spreadsheetId, range }) => ({
      spreadsheetId,
      range,
      values: range.endsWith("I11") || range.endsWith("E11")
        ? [[value]]
        : profileValues(),
    }),
    readSheetGridMetadata: async ({ range }) =>
      range.endsWith("I11") || range.endsWith("E11")
        ? targetGrid
        : {
            ...emptyGrid(),
            formulaColumns: [7, 8, 9, 10, 11],
            formulaCells: [
              {
                rowIndex: 11,
                columnIndex: 8,
                formula: "=SUM(I4:I11)",
              },
            ],
          },
    createSheetTab: async () => ({ sheetId: 1, reused: false }),
    appendRows: async () => ({ reused: false }),
    updateCells: async ({ values }) => {
      updateCalls += 1;
      if (!ignoreWrites) value = values[0]?.[0] ?? null;
    },
    clearRange: async () => undefined,
  };

  return {
    adapter,
    value: () => value,
    updateCalls: () => updateCalls,
  };
}

function emptyGrid(): SheetGridMetadata {
  return {
    spreadsheetId: "launch-sheet",
    sheetId: 1,
    sheetName: "ОФФЕРЫ И РАССЫЛКИ",
    formulaColumns: [],
    protectedColumns: [],
    formulaCells: [],
    protectedRanges: [],
  };
}

function profileValues(): SheetScalar[][] {
  return [
    ["ОФФЕРЫ И РАССЫЛКИ — ТЕСТЫ ПО СЕГМЕНТАМ"],
    ["Один оффер = одна гипотеза"],
    [
      "Дата",
      "Сегмент",
      "Модель",
      "Оффер / результат",
      "Первое сообщение",
      "Повторное сообщение",
      "Техническая реализация",
      "План отправок",
      "Отправлено",
      "Ответы",
      "Интервью",
      "Обсуждения пилота",
    ],
    ["2026-07-14", "Маркетологи", "Партнёрский канал"],
    [],
    [],
    [],
    [],
    [],
    [],
    [
      "2026-07-22",
      "Маркетологи / партнёры",
      "Партнёрский вход",
      "Узкий AI-спринт",
      "Первоначальный текст",
      "Follow-up ещё не зафиксирован",
      "Baseline и прототип",
      3,
      3,
      0,
      0,
      0,
    ],
    ["2026-07-22", "ИТОГО", "", "", "", "", "", 10, 10, 0, 0, 0],
  ];
}
