import type {
  GoogleSheetBlueprint,
  GridRangeBlueprint,
  SheetColor,
} from "./types";

export const OWN_PROJECT_OPERATIONS_BLUEPRINT_ID =
  "own-project-operations-v1";

const TASKS_SHEET_ID = 1001;
const METRICS_SHEET_ID = 1002;
const DASHBOARD_SHEET_ID = 1003;

const GREEN: SheetColor = { red: 0.82, green: 0.94, blue: 0.84 };
const RED: SheetColor = { red: 0.98, green: 0.84, blue: 0.84 };
const ORANGE: SheetColor = { red: 1, green: 0.91, blue: 0.75 };

export function createOwnProjectOperationsBlueprint(
  title = "Операционный трекер собственного проекта",
  timeZone = process.env.USER_TIMEZONE,
): GoogleSheetBlueprint {
  return {
    id: OWN_PROJECT_OPERATIONS_BLUEPRINT_ID,
    version: 1,
    title,
    locale: "ru_RU",
    timeZone,
    tabs: [
      {
        sheetId: TASKS_SHEET_ID,
        title: "Задачи",
        rowCount: 250,
        columnCount: 9,
        frozenRowCount: 1,
        frozenColumnCount: 1,
        values: [
          {
            startRowIndex: 0,
            startColumnIndex: 0,
            rows: [
              [
                "ID",
                "Задача",
                "Дедлайн",
                "Ответственный",
                "Статус",
                "Приоритет",
                "План",
                "Факт",
                "Отклонение",
              ],
              [
                "",
                "",
                null,
                "",
                "Не начато",
                "Средний",
                null,
                null,
                { formula: '=IF(OR(G2="";H2="");"";H2-G2)' },
              ],
            ],
          },
        ],
        headerRanges: [range(TASKS_SHEET_ID, 0, 1, 0, 9)],
        filter: range(TASKS_SHEET_ID, 0, 200, 0, 9),
        dropdowns: [
          {
            range: range(TASKS_SHEET_ID, 1, 200, 4, 5),
            values: ["Не начато", "В работе", "Заблокировано", "Готово"],
          },
          {
            range: range(TASKS_SHEET_ID, 1, 200, 5, 6),
            values: ["Низкий", "Средний", "Высокий", "Критический"],
          },
        ],
        numberFormats: [
          {
            range: range(TASKS_SHEET_ID, 1, 200, 2, 3),
            type: "DATE",
            pattern: "dd.mm.yyyy",
          },
          {
            range: range(TASKS_SHEET_ID, 1, 200, 6, 9),
            type: "NUMBER",
            pattern: "#,##0.00",
          },
        ],
        conditionalFormats: [
          {
            range: range(TASKS_SHEET_ID, 1, 200, 4, 5),
            condition: "text_eq",
            value: "Готово",
            backgroundColor: GREEN,
          },
          {
            range: range(TASKS_SHEET_ID, 1, 200, 0, 9),
            condition: "custom_formula",
            formula: '=AND($C2<TODAY();$C2<>"";$E2<>"Готово")',
            backgroundColor: RED,
          },
          {
            range: range(TASKS_SHEET_ID, 1, 200, 5, 6),
            condition: "text_eq",
            value: "Критический",
            backgroundColor: ORANGE,
          },
        ],
        columnWidths: [
          { startIndex: 0, endIndex: 1, pixelSize: 70 },
          { startIndex: 1, endIndex: 2, pixelSize: 320 },
          { startIndex: 2, endIndex: 3, pixelSize: 120 },
          { startIndex: 3, endIndex: 4, pixelSize: 160 },
          { startIndex: 4, endIndex: 6, pixelSize: 140 },
          { startIndex: 6, endIndex: 9, pixelSize: 110 },
        ],
        charts: [],
      },
      {
        sheetId: METRICS_SHEET_ID,
        title: "Метрики",
        rowCount: 100,
        columnCount: 6,
        frozenRowCount: 1,
        values: [
          {
            startRowIndex: 0,
            startColumnIndex: 0,
            rows: [
              [
                "Показатель",
                "Единица",
                "План",
                "Факт",
                "Отклонение",
                "Выполнение %",
              ],
              [
                "Выручка",
                "₽",
                100000,
                0,
                { formula: "=D2-C2" },
                { formula: "=IFERROR(D2/C2;0)" },
              ],
              [
                "Лиды",
                "шт.",
                100,
                0,
                { formula: "=D3-C3" },
                { formula: "=IFERROR(D3/C3;0)" },
              ],
              [
                "Продажи",
                "шт.",
                10,
                0,
                { formula: "=D4-C4" },
                { formula: "=IFERROR(D4/C4;0)" },
              ],
              [
                "Расходы",
                "₽",
                50000,
                0,
                { formula: "=D5-C5" },
                { formula: "=IFERROR(D5/C5;0)" },
              ],
              [
                "Прибыль",
                "₽",
                50000,
                0,
                { formula: "=D6-C6" },
                { formula: "=IFERROR(D6/C6;0)" },
              ],
            ],
          },
        ],
        headerRanges: [range(METRICS_SHEET_ID, 0, 1, 0, 6)],
        filter: range(METRICS_SHEET_ID, 0, 50, 0, 6),
        dropdowns: [],
        numberFormats: [
          {
            range: range(METRICS_SHEET_ID, 1, 50, 2, 5),
            type: "NUMBER",
            pattern: "#,##0.00",
          },
          {
            range: range(METRICS_SHEET_ID, 1, 50, 5, 6),
            type: "PERCENT",
            pattern: "0.0%",
          },
        ],
        conditionalFormats: [
          {
            range: range(METRICS_SHEET_ID, 1, 50, 5, 6),
            condition: "number_gte",
            value: 1,
            backgroundColor: GREEN,
          },
          {
            range: range(METRICS_SHEET_ID, 1, 50, 5, 6),
            condition: "custom_formula",
            formula: "=$F2<0,8",
            backgroundColor: RED,
          },
        ],
        columnWidths: [
          { startIndex: 0, endIndex: 1, pixelSize: 190 },
          { startIndex: 1, endIndex: 2, pixelSize: 100 },
          { startIndex: 2, endIndex: 6, pixelSize: 130 },
        ],
        charts: [],
      },
      {
        sheetId: DASHBOARD_SHEET_ID,
        title: "Дашборд",
        rowCount: 60,
        columnCount: 12,
        frozenRowCount: 1,
        values: [
          {
            startRowIndex: 0,
            startColumnIndex: 0,
            rows: [
              ["Операционный дашборд", ""],
              ["", ""],
              ["KPI", "Значение"],
              [
                "Всего задач",
                { formula: "=COUNTA('Задачи'!B2:B)" },
              ],
              [
                "Готово",
                { formula: '=COUNTIF(\'Задачи\'!E2:E;"Готово")' },
              ],
              ["Прогресс", { formula: "=IFERROR(B5/B4;0)" }],
              ["", ""],
              ["Статус", "Количество"],
              [
                "Не начато",
                {
                  formula:
                    '=COUNTIF(\'Задачи\'!E2:E;"Не начато")',
                },
              ],
              [
                "В работе",
                {
                  formula: '=COUNTIF(\'Задачи\'!E2:E;"В работе")',
                },
              ],
              [
                "Заблокировано",
                {
                  formula:
                    '=COUNTIF(\'Задачи\'!E2:E;"Заблокировано")',
                },
              ],
              [
                "Готово",
                {
                  formula: '=COUNTIF(\'Задачи\'!E2:E;"Готово")',
                },
              ],
            ],
          },
        ],
        headerRanges: [
          range(DASHBOARD_SHEET_ID, 0, 1, 0, 2),
          range(DASHBOARD_SHEET_ID, 2, 3, 0, 2),
          range(DASHBOARD_SHEET_ID, 7, 8, 0, 2),
        ],
        dropdowns: [],
        numberFormats: [
          {
            range: range(DASHBOARD_SHEET_ID, 5, 6, 1, 2),
            type: "PERCENT",
            pattern: "0.0%",
          },
        ],
        conditionalFormats: [],
        columnWidths: [
          { startIndex: 0, endIndex: 1, pixelSize: 190 },
          { startIndex: 1, endIndex: 2, pixelSize: 130 },
        ],
        charts: [
          {
            type: "COLUMN",
            title: "План и факт по показателям",
            sourceSheetId: METRICS_SHEET_ID,
            domain: rangeWithoutSheet(0, 6, 0, 1),
            series: [
              rangeWithoutSheet(0, 6, 2, 3),
              rangeWithoutSheet(0, 6, 3, 4),
            ],
            anchor: {
              rowIndex: 0,
              columnIndex: 3,
              widthPixels: 720,
              heightPixels: 360,
            },
          },
          {
            type: "PIE",
            title: "Статусы задач",
            sourceSheetId: DASHBOARD_SHEET_ID,
            domain: rangeWithoutSheet(7, 12, 0, 1),
            series: [rangeWithoutSheet(7, 12, 1, 2)],
            anchor: {
              rowIndex: 19,
              columnIndex: 3,
              widthPixels: 620,
              heightPixels: 340,
            },
          },
        ],
      },
    ],
  };
}

function range(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
): GridRangeBlueprint {
  return {
    sheetId,
    startRowIndex,
    endRowIndex,
    startColumnIndex,
    endColumnIndex,
  };
}

function rangeWithoutSheet(
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
) {
  return {
    startRowIndex,
    endRowIndex,
    startColumnIndex,
    endColumnIndex,
  };
}
