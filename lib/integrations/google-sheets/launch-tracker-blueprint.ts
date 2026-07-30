import type {
  GoogleSheetBlueprint,
  GridRangeBlueprint,
  SheetColor,
} from "./types";

export const OWN_PROJECT_OPERATIONS_BLUEPRINT_ID =
  "own-project-operations-v2";

const TASKS_SHEET_ID = 1001;
const METRICS_SHEET_ID = 1002;
const DASHBOARD_SHEET_ID = 1003;

const NAVY: SheetColor = { red: 0.12, green: 0.31, blue: 0.47 };
const BLUE: SheetColor = { red: 0.18, green: 0.49, blue: 0.72 };
const LIGHT_BLUE: SheetColor = { red: 0.89, green: 0.95, blue: 0.98 };
const PALE_BLUE: SheetColor = { red: 0.96, green: 0.98, blue: 1 };
const WHITE: SheetColor = { red: 1, green: 1, blue: 1 };
const TEXT: SheetColor = { red: 0.12, green: 0.16, blue: 0.2 };
const BORDER: SheetColor = { red: 0.74, green: 0.8, blue: 0.84 };
const GREEN: SheetColor = { red: 0.82, green: 0.94, blue: 0.84 };
const RED: SheetColor = { red: 0.98, green: 0.84, blue: 0.84 };
const ORANGE: SheetColor = { red: 1, green: 0.91, blue: 0.75 };
const STATUS_BLUE: SheetColor = { red: 0.82, green: 0.9, blue: 0.98 };

export function createOwnProjectOperationsBlueprint(
  title = "Операционный трекер собственного проекта",
  timeZone = process.env.USER_TIMEZONE,
): GoogleSheetBlueprint {
  return {
    id: OWN_PROJECT_OPERATIONS_BLUEPRINT_ID,
    version: 2,
    title,
    locale: "ru_RU",
    timeZone,
    tabs: [
      createTasksTab(title),
      createMetricsTab(title),
      createDashboardTab(title),
    ],
  };
}

function createTasksTab(projectTitle: string) {
  return {
    sheetId: TASKS_SHEET_ID,
    title: "Задачи",
    rowCount: 250,
    columnCount: 9,
    frozenRowCount: 3,
    frozenColumnCount: 1,
    tabColor: NAVY,
    values: [
      {
        startRowIndex: 0,
        startColumnIndex: 0,
        rows: [
          [`Задачи · ${projectTitle}`, "", "", "", "", "", "", "", ""],
          [
            "Планируйте конкретные результаты. Статусы, приоритеты и отклонения рассчитываются автоматически.",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
          ],
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
            {
              formula:
                '=ARRAYFORMULA(IF((G4:G="")+(H4:H="");"";H4:H-G4:G))',
            },
          ],
        ],
      },
    ],
    merges: [
      { range: range(TASKS_SHEET_ID, 0, 1, 0, 9), type: "MERGE_ALL" as const },
      { range: range(TASKS_SHEET_ID, 1, 2, 0, 9), type: "MERGE_ALL" as const },
    ],
    headerRanges: [],
    styles: [
      titleStyle(TASKS_SHEET_ID, 9),
      subtitleStyle(TASKS_SHEET_ID, 9),
      tableHeaderStyle(TASKS_SHEET_ID, 2, 3, 9),
      {
        range: range(TASKS_SHEET_ID, 3, 200, 0, 9),
        foregroundColor: TEXT,
        verticalAlignment: "MIDDLE" as const,
        wrapStrategy: "WRAP" as const,
      },
      {
        range: range(TASKS_SHEET_ID, 3, 200, 2, 9),
        horizontalAlignment: "CENTER" as const,
      },
    ],
    borders: [
      {
        range: range(TASKS_SHEET_ID, 2, 200, 0, 9),
        color: BORDER,
        style: "SOLID" as const,
        outer: true,
        innerHorizontal: true,
      },
    ],
    bandedRanges: [
      {
        range: range(TASKS_SHEET_ID, 2, 200, 0, 9),
        headerColor: NAVY,
        firstBandColor: WHITE,
        secondBandColor: PALE_BLUE,
      },
    ],
    filter: range(TASKS_SHEET_ID, 2, 200, 0, 9),
    dropdowns: [
      {
        range: range(TASKS_SHEET_ID, 3, 200, 4, 5),
        values: ["Не начато", "В работе", "Заблокировано", "Готово"],
      },
      {
        range: range(TASKS_SHEET_ID, 3, 200, 5, 6),
        values: ["Низкий", "Средний", "Высокий", "Критический"],
      },
    ],
    numberFormats: [
      {
        range: range(TASKS_SHEET_ID, 3, 200, 2, 3),
        type: "DATE" as const,
        pattern: "dd.mm.yyyy",
      },
      {
        range: range(TASKS_SHEET_ID, 3, 200, 6, 9),
        type: "NUMBER" as const,
        pattern: "#,##0.00",
      },
    ],
    conditionalFormats: [
      {
        range: range(TASKS_SHEET_ID, 3, 200, 4, 5),
        condition: "text_eq" as const,
        value: "В работе",
        backgroundColor: STATUS_BLUE,
      },
      {
        range: range(TASKS_SHEET_ID, 3, 200, 4, 5),
        condition: "text_eq" as const,
        value: "Готово",
        backgroundColor: GREEN,
      },
      {
        range: range(TASKS_SHEET_ID, 3, 200, 4, 5),
        condition: "text_eq" as const,
        value: "Заблокировано",
        backgroundColor: ORANGE,
      },
      {
        range: range(TASKS_SHEET_ID, 3, 200, 0, 9),
        condition: "custom_formula" as const,
        formula: '=AND($C4<TODAY();$C4<>"";$E4<>"Готово")',
        backgroundColor: RED,
      },
      {
        range: range(TASKS_SHEET_ID, 3, 200, 5, 6),
        condition: "text_eq" as const,
        value: "Критический",
        backgroundColor: RED,
      },
    ],
    columnWidths: [
      { startIndex: 0, endIndex: 1, pixelSize: 72 },
      { startIndex: 1, endIndex: 2, pixelSize: 340 },
      { startIndex: 2, endIndex: 3, pixelSize: 125 },
      { startIndex: 3, endIndex: 4, pixelSize: 180 },
      { startIndex: 4, endIndex: 6, pixelSize: 150 },
      { startIndex: 6, endIndex: 9, pixelSize: 115 },
    ],
    rowHeights: [
      { startIndex: 0, endIndex: 1, pixelSize: 46 },
      { startIndex: 1, endIndex: 2, pixelSize: 38 },
      { startIndex: 2, endIndex: 3, pixelSize: 36 },
      { startIndex: 3, endIndex: 200, pixelSize: 30 },
    ],
    charts: [],
  };
}

function createMetricsTab(projectTitle: string) {
  return {
    sheetId: METRICS_SHEET_ID,
    title: "Метрики",
    rowCount: 100,
    columnCount: 6,
    frozenRowCount: 3,
    tabColor: BLUE,
    values: [
      {
        startRowIndex: 0,
        startColumnIndex: 0,
        rows: [
          [`Метрики · ${projectTitle}`, "", "", "", "", ""],
          [
            "Заполняйте план и факт — отклонение и процент выполнения рассчитываются автоматически.",
            "",
            "",
            "",
            "",
            "",
          ],
          [
            "Показатель",
            "Единица",
            "План",
            "Факт",
            "Отклонение",
            "Выполнение %",
          ],
          ["Выручка", "₽", 100000, 0, { formula: "=D4-C4" }, { formula: "=IFERROR(D4/C4;0)" }],
          ["Лиды", "шт.", 100, 0, { formula: "=D5-C5" }, { formula: "=IFERROR(D5/C5;0)" }],
          ["Продажи", "шт.", 10, 0, { formula: "=D6-C6" }, { formula: "=IFERROR(D6/C6;0)" }],
          ["Расходы", "₽", 50000, 0, { formula: "=D7-C7" }, { formula: "=IFERROR(D7/C7;0)" }],
          ["Прибыль", "₽", 50000, 0, { formula: "=D8-C8" }, { formula: "=IFERROR(D8/C8;0)" }],
        ],
      },
    ],
    merges: [
      { range: range(METRICS_SHEET_ID, 0, 1, 0, 6), type: "MERGE_ALL" as const },
      { range: range(METRICS_SHEET_ID, 1, 2, 0, 6), type: "MERGE_ALL" as const },
    ],
    headerRanges: [],
    styles: [
      titleStyle(METRICS_SHEET_ID, 6),
      subtitleStyle(METRICS_SHEET_ID, 6),
      tableHeaderStyle(METRICS_SHEET_ID, 2, 3, 6),
      {
        range: range(METRICS_SHEET_ID, 3, 50, 0, 6),
        foregroundColor: TEXT,
        verticalAlignment: "MIDDLE" as const,
      },
      {
        range: range(METRICS_SHEET_ID, 3, 50, 1, 6),
        horizontalAlignment: "CENTER" as const,
      },
    ],
    borders: [
      {
        range: range(METRICS_SHEET_ID, 2, 50, 0, 6),
        color: BORDER,
        style: "SOLID" as const,
        outer: true,
        innerHorizontal: true,
      },
    ],
    bandedRanges: [
      {
        range: range(METRICS_SHEET_ID, 2, 50, 0, 6),
        headerColor: NAVY,
        firstBandColor: WHITE,
        secondBandColor: PALE_BLUE,
      },
    ],
    filter: range(METRICS_SHEET_ID, 2, 50, 0, 6),
    dropdowns: [],
    numberFormats: [
      {
        range: range(METRICS_SHEET_ID, 3, 50, 2, 5),
        type: "NUMBER" as const,
        pattern: "#,##0.00",
      },
      {
        range: range(METRICS_SHEET_ID, 3, 50, 5, 6),
        type: "PERCENT" as const,
        pattern: "0.0%",
      },
    ],
    conditionalFormats: [
      {
        range: range(METRICS_SHEET_ID, 3, 50, 5, 6),
        condition: "number_gte" as const,
        value: 1,
        backgroundColor: GREEN,
      },
      {
        range: range(METRICS_SHEET_ID, 3, 50, 5, 6),
        condition: "custom_formula" as const,
        formula: "=$F4<0,8",
        backgroundColor: RED,
      },
    ],
    columnWidths: [
      { startIndex: 0, endIndex: 1, pixelSize: 210 },
      { startIndex: 1, endIndex: 2, pixelSize: 100 },
      { startIndex: 2, endIndex: 6, pixelSize: 135 },
    ],
    rowHeights: [
      { startIndex: 0, endIndex: 1, pixelSize: 46 },
      { startIndex: 1, endIndex: 2, pixelSize: 38 },
      { startIndex: 2, endIndex: 3, pixelSize: 36 },
      { startIndex: 3, endIndex: 50, pixelSize: 30 },
    ],
    charts: [],
  };
}

function createDashboardTab(projectTitle: string) {
  return {
    sheetId: DASHBOARD_SHEET_ID,
    title: "Дашборд",
    rowCount: 60,
    columnCount: 12,
    frozenRowCount: 2,
    tabColor: GREEN,
    hideGridlines: true,
    values: [
      {
        startRowIndex: 0,
        startColumnIndex: 0,
        rows: [
          [`Операционный дашборд · ${projectTitle}`, "", "", "", "", "", "", "", "", "", "", ""],
          ["Ключевые показатели, прогресс и распределение задач обновляются автоматически.", "", "", "", "", "", "", "", "", "", "", ""],
          ["", ""],
          ["KPI", "Значение"],
          ["Всего задач", { formula: "=COUNTA('Задачи'!B4:B)" }],
          ["Готово", { formula: '=COUNTIF(\'Задачи\'!E4:E;"Готово")' }],
          ["Прогресс", { formula: "=IFERROR(B6/B5;0)" }],
          ["", ""],
          ["Статус", "Количество"],
          ["Не начато", { formula: '=COUNTIF(\'Задачи\'!E4:E;"Не начато")' }],
          ["В работе", { formula: '=COUNTIF(\'Задачи\'!E4:E;"В работе")' }],
          ["Заблокировано", { formula: '=COUNTIF(\'Задачи\'!E4:E;"Заблокировано")' }],
          ["Готово", { formula: '=COUNTIF(\'Задачи\'!E4:E;"Готово")' }],
        ],
      },
    ],
    merges: [
      { range: range(DASHBOARD_SHEET_ID, 0, 1, 0, 12), type: "MERGE_ALL" as const },
      { range: range(DASHBOARD_SHEET_ID, 1, 2, 0, 12), type: "MERGE_ALL" as const },
    ],
    headerRanges: [],
    styles: [
      titleStyle(DASHBOARD_SHEET_ID, 12),
      subtitleStyle(DASHBOARD_SHEET_ID, 12),
      tableHeaderStyle(DASHBOARD_SHEET_ID, 3, 4, 2),
      tableHeaderStyle(DASHBOARD_SHEET_ID, 8, 9, 2),
      {
        range: range(DASHBOARD_SHEET_ID, 4, 7, 0, 1),
        backgroundColor: LIGHT_BLUE,
        bold: true,
        foregroundColor: TEXT,
      },
      {
        range: range(DASHBOARD_SHEET_ID, 4, 7, 1, 2),
        backgroundColor: WHITE,
        foregroundColor: NAVY,
        bold: true,
        fontSize: 14,
        horizontalAlignment: "CENTER" as const,
      },
      {
        range: range(DASHBOARD_SHEET_ID, 9, 13, 0, 2),
        verticalAlignment: "MIDDLE" as const,
      },
    ],
    borders: [
      {
        range: range(DASHBOARD_SHEET_ID, 3, 7, 0, 2),
        color: BORDER,
        style: "SOLID_MEDIUM" as const,
        outer: true,
        innerHorizontal: true,
        innerVertical: true,
      },
      {
        range: range(DASHBOARD_SHEET_ID, 8, 13, 0, 2),
        color: BORDER,
        style: "SOLID" as const,
        outer: true,
        innerHorizontal: true,
      },
    ],
    bandedRanges: [
      {
        range: range(DASHBOARD_SHEET_ID, 8, 13, 0, 2),
        headerColor: NAVY,
        firstBandColor: WHITE,
        secondBandColor: PALE_BLUE,
      },
    ],
    dropdowns: [],
    numberFormats: [
      {
        range: range(DASHBOARD_SHEET_ID, 6, 7, 1, 2),
        type: "PERCENT" as const,
        pattern: "0.0%",
      },
    ],
    conditionalFormats: [],
    columnWidths: [
      { startIndex: 0, endIndex: 1, pixelSize: 210 },
      { startIndex: 1, endIndex: 2, pixelSize: 140 },
      { startIndex: 2, endIndex: 12, pixelSize: 95 },
    ],
    rowHeights: [
      { startIndex: 0, endIndex: 1, pixelSize: 50 },
      { startIndex: 1, endIndex: 2, pixelSize: 38 },
      { startIndex: 3, endIndex: 13, pixelSize: 34 },
    ],
    charts: [
      {
        type: "COLUMN" as const,
        title: "План и факт по показателям",
        sourceSheetId: METRICS_SHEET_ID,
        domain: rangeWithoutSheet(2, 8, 0, 1),
        series: [
          rangeWithoutSheet(2, 8, 2, 3),
          rangeWithoutSheet(2, 8, 3, 4),
        ],
        anchor: {
          rowIndex: 3,
          columnIndex: 3,
          widthPixels: 720,
          heightPixels: 360,
        },
      },
      {
        type: "PIE" as const,
        title: "Статусы задач",
        sourceSheetId: DASHBOARD_SHEET_ID,
        domain: rangeWithoutSheet(8, 13, 0, 1),
        series: [rangeWithoutSheet(8, 13, 1, 2)],
        anchor: {
          rowIndex: 20,
          columnIndex: 3,
          widthPixels: 620,
          heightPixels: 340,
        },
      },
    ],
  };
}

function titleStyle(sheetId: number, columnCount: number) {
  return {
    range: range(sheetId, 0, 1, 0, columnCount),
    backgroundColor: NAVY,
    foregroundColor: WHITE,
    bold: true,
    fontSize: 16,
    horizontalAlignment: "LEFT" as const,
    verticalAlignment: "MIDDLE" as const,
  };
}

function subtitleStyle(sheetId: number, columnCount: number) {
  return {
    range: range(sheetId, 1, 2, 0, columnCount),
    backgroundColor: LIGHT_BLUE,
    foregroundColor: TEXT,
    fontSize: 10,
    verticalAlignment: "MIDDLE" as const,
    wrapStrategy: "WRAP" as const,
  };
}

function tableHeaderStyle(
  sheetId: number,
  startRowIndex: number,
  endRowIndex: number,
  columnCount: number,
) {
  return {
    range: range(
      sheetId,
      startRowIndex,
      endRowIndex,
      0,
      columnCount,
    ),
    backgroundColor: NAVY,
    foregroundColor: WHITE,
    bold: true,
    horizontalAlignment: "CENTER" as const,
    verticalAlignment: "MIDDLE" as const,
    wrapStrategy: "WRAP" as const,
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
