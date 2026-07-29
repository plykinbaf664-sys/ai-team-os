export type SheetScalar = string | number | boolean | null;

export type SheetCellInput =
  | SheetScalar
  | {
      formula: string;
    };

export type GridRangeBlueprint = {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
};

export type SheetValueBlock = {
  startRowIndex: number;
  startColumnIndex: number;
  rows: SheetCellInput[][];
};

export type SheetDropdown = {
  range: GridRangeBlueprint;
  values: string[];
};

export type SheetConditionalFormat =
  | {
      range: GridRangeBlueprint;
      condition: "text_eq";
      value: string;
      backgroundColor: SheetColor;
    }
  | {
      range: GridRangeBlueprint;
      condition: "number_gte" | "number_lt";
      value: number;
      backgroundColor: SheetColor;
    }
  | {
      range: GridRangeBlueprint;
      condition: "custom_formula";
      formula: string;
      backgroundColor: SheetColor;
    };

export type SheetNumberFormat = {
  range: GridRangeBlueprint;
  type: "DATE" | "NUMBER" | "PERCENT" | "CURRENCY";
  pattern?: string;
};

export type SheetColor = {
  red: number;
  green: number;
  blue: number;
};

export type SheetChartBlueprint = {
  type: "COLUMN" | "LINE" | "PIE";
  title: string;
  sourceSheetId: number;
  domain: Omit<GridRangeBlueprint, "sheetId">;
  series: Array<Omit<GridRangeBlueprint, "sheetId">>;
  anchor: {
    rowIndex: number;
    columnIndex: number;
    widthPixels: number;
    heightPixels: number;
  };
};

export type SheetTabBlueprint = {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
  frozenRowCount?: number;
  frozenColumnCount?: number;
  values: SheetValueBlock[];
  headerRanges: GridRangeBlueprint[];
  filter?: GridRangeBlueprint;
  dropdowns: SheetDropdown[];
  numberFormats: SheetNumberFormat[];
  conditionalFormats: SheetConditionalFormat[];
  columnWidths: Array<{
    startIndex: number;
    endIndex: number;
    pixelSize: number;
  }>;
  charts: SheetChartBlueprint[];
};

export type GoogleSheetBlueprint = {
  id: string;
  version: number;
  title: string;
  locale: string;
  timeZone?: string;
  tabs: SheetTabBlueprint[];
};

export type CreatedSpreadsheet = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  reused: boolean;
};

export type GoogleSheetsAdapter = {
  createSpreadsheet(
    blueprint: GoogleSheetBlueprint,
    idempotencyKey: string,
  ): Promise<CreatedSpreadsheet>;
  createSheetTab(input: {
    spreadsheetId: string;
    title: string;
  }): Promise<{ sheetId: number; reused: boolean }>;
  appendRows(input: {
    spreadsheetId: string;
    range: string;
    values: SheetScalar[][];
    idempotencyKey: string;
  }): Promise<void>;
  updateCells(input: {
    spreadsheetId: string;
    range: string;
    values: SheetScalar[][];
  }): Promise<void>;
  clearRange(input: {
    spreadsheetId: string;
    range: string;
  }): Promise<void>;
};
