export type SheetScalar = string | number | boolean | null;

export type SheetCellInput =
  | SheetScalar
  | {
      formula: string;
    }
  | {
      chip:
        | {
            type: "person";
            email: string;
            displayFormat?:
              | "DEFAULT"
              | "LAST_NAME_COMMA_FIRST_NAME"
              | "EMAIL";
          }
        | {
            type: "drive_file";
            uri: string;
          };
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

export type SheetRangeStyle = {
  range: GridRangeBlueprint;
  backgroundColor?: SheetColor;
  foregroundColor?: SheetColor;
  bold?: boolean;
  fontSize?: number;
  horizontalAlignment?: "LEFT" | "CENTER" | "RIGHT";
  verticalAlignment?: "TOP" | "MIDDLE" | "BOTTOM";
  wrapStrategy?: "OVERFLOW_CELL" | "LEGACY_WRAP" | "CLIP" | "WRAP";
};

export type SheetBorderBlueprint = {
  range: GridRangeBlueprint;
  color: SheetColor;
  style: "SOLID" | "SOLID_MEDIUM" | "SOLID_THICK";
  outer: boolean;
  innerHorizontal?: boolean;
  innerVertical?: boolean;
};

export type SheetBandedRange = {
  range: GridRangeBlueprint;
  headerColor?: SheetColor;
  firstBandColor: SheetColor;
  secondBandColor: SheetColor;
};

export type SheetMerge = {
  range: GridRangeBlueprint;
  type: "MERGE_ALL" | "MERGE_ROWS" | "MERGE_COLUMNS";
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
  styles: SheetRangeStyle[];
  borders: SheetBorderBlueprint[];
  bandedRanges: SheetBandedRange[];
  merges: SheetMerge[];
  filter?: GridRangeBlueprint;
  dropdowns: SheetDropdown[];
  numberFormats: SheetNumberFormat[];
  conditionalFormats: SheetConditionalFormat[];
  columnWidths: Array<{
    startIndex: number;
    endIndex: number;
    pixelSize: number;
  }>;
  rowHeights: Array<{
    startIndex: number;
    endIndex: number;
    pixelSize: number;
  }>;
  tabColor?: SheetColor;
  hideGridlines?: boolean;
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

export type ExistingSpreadsheetSummary = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  modifiedTime?: string;
};

export type ExistingSpreadsheetTab = {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
  frozenRowCount: number;
  frozenColumnCount: number;
};

export type ExistingSpreadsheetMetadata = ExistingSpreadsheetSummary & {
  locale?: string;
  timeZone?: string;
  tabs: ExistingSpreadsheetTab[];
};

export type SheetRangeRead = {
  spreadsheetId: string;
  range: string;
  values: SheetScalar[][];
};

export type SheetColumnRole =
  | "key"
  | "metric"
  | "status"
  | "text"
  | "formula"
  | "unknown";

export type SheetColumnDataType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "mixed"
  | "empty";

export type SheetUpdatePolicy =
  | "preserve"
  | "increment"
  | "replace"
  | "append_text"
  | "formula"
  | "protected";

export type SheetColumnProfile = {
  index: number;
  columnLetter: string;
  header: string;
  semanticKey: string;
  role: SheetColumnRole;
  dataType: SheetColumnDataType;
  updatePolicy: SheetUpdatePolicy;
  isFormula: boolean;
  isProtected: boolean;
};

export type SheetRowMatchingRule = {
  keyColumns: string[];
  minimumConfidence: number;
  ambiguityDelta: number;
};

export type SheetProfile = {
  version: 1;
  spreadsheetId: string;
  sheetId: number;
  sheetName: string;
  purpose: string;
  entityType:
    | "outreach_segment"
    | "task"
    | "metric_record"
    | "activity_log"
    | "generic_table";
  headerRowNumber: number;
  columns: SheetColumnProfile[];
  keyColumns: string[];
  metricColumns: string[];
  statusColumns: string[];
  textColumns: string[];
  formulaColumns: string[];
  protectedColumns: string[];
  rowMatchingRules: SheetRowMatchingRule;
  projectId?: string;
  linkedTickTickProjectId?: string;
  fingerprint: string;
};

export type SheetRowEntity = {
  entityId: string;
  rowNumber: number;
  rowKey: string;
  normalizedKey: string;
  aliases: string[];
  values: SheetScalar[];
};

export type SheetRowMatch = {
  entity: SheetRowEntity;
  confidence: number;
  evidence: string[];
};

export type SheetGridMetadata = {
  spreadsheetId: string;
  sheetId: number;
  sheetName: string;
  formulaColumns: number[];
  protectedColumns: number[];
  formulaCells?: Array<{
    rowIndex: number;
    columnIndex: number;
    formula: string;
  }>;
  protectedRanges?: Array<{
    startRowIndex?: number;
    endRowIndex?: number;
    startColumnIndex?: number;
    endColumnIndex?: number;
  }>;
};

export type GoogleSheetsAdapter = {
  createSpreadsheet(
    blueprint: GoogleSheetBlueprint,
    idempotencyKey: string,
  ): Promise<CreatedSpreadsheet>;
  findSpreadsheetsByTitle(
    title: string,
  ): Promise<ExistingSpreadsheetSummary[]>;
  listSpreadsheets(): Promise<ExistingSpreadsheetSummary[]>;
  getSpreadsheetMetadata(
    spreadsheetId: string,
  ): Promise<ExistingSpreadsheetMetadata>;
  readRange(input: {
    spreadsheetId: string;
    range: string;
  }): Promise<SheetRangeRead>;
  readSheetGridMetadata(input: {
    spreadsheetId: string;
    range: string;
  }): Promise<SheetGridMetadata>;
  createSheetTab(input: {
    spreadsheetId: string;
    title: string;
  }): Promise<{ sheetId: number; reused: boolean }>;
  appendRows(input: {
    spreadsheetId: string;
    range: string;
    values: SheetScalar[][];
    idempotencyKey: string;
  }): Promise<{ updatedRange?: string; reused: boolean }>;
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
