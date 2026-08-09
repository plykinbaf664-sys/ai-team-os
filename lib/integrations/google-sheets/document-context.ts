import type { AssistantConversationMessage } from "@/lib/agents/assistant/types";
import type {
  ExistingSpreadsheetMetadata,
  ExistingSpreadsheetSummary,
  GoogleSheetsAdapter,
  SheetProfile,
  SheetRowEntity,
  SheetRowMatch,
  SheetScalar,
} from "./types";
import { buildSheetProfile } from "./sheet-profile";
import {
  buildSheetRowEntities,
  matchSheetRows,
} from "./row-matcher";

export type InspectedSheetTab = {
  title: string;
  range: string;
  values: SheetScalar[][];
  profile: SheetProfile;
  entities: SheetRowEntity[];
  rowMatches: SheetRowMatch[];
};

export type InspectedSpreadsheet = {
  spreadsheetId: string;
  title: string;
  spreadsheetUrl: string;
  tabs: InspectedSheetTab[];
};

export type GoogleSheetsWorkspaceContext = {
  availableDocuments: ExistingSpreadsheetSummary[];
  inspectedDocuments: InspectedSpreadsheet[];
};

const MAX_DOCUMENTS = 3;
const MAX_TABS_PER_DOCUMENT = 8;
const MAX_METADATA_TABS_PER_DOCUMENT = 30;
const MAX_SAMPLE_ROWS = 12;
const MAX_SAMPLE_COLUMNS = 12;
const MAX_CONTEXT_CHARACTERS = 12_000;

export async function inspectGoogleSheetsWorkspace({
  adapter,
  sourceText,
  conversation = [],
  preferredSpreadsheetIds = [],
  metadataOnly = false,
}: {
  adapter: GoogleSheetsAdapter;
  sourceText: string;
  conversation?: AssistantConversationMessage[];
  preferredSpreadsheetIds?: string[];
  metadataOnly?: boolean;
}): Promise<GoogleSheetsWorkspaceContext> {
  const availableDocuments = await adapter.listSpreadsheets();
  const contextText = [
    sourceText,
    ...conversation.slice(-12).map((message) => message.text),
  ].join("\n");
  const selectionText = [
    sourceText,
    ...conversation
      .filter(
        (message) =>
          message.role === "user" ||
          /работаем\s+с\s+таблиц|активн\w*\s+таблиц|связан\w*\s+таблиц/iu.test(
            message.text,
          ),
      )
      .slice(-8)
      .map((message) => message.text),
  ].join("\n");
  const normalizedSelection = normalizeText(selectionText);
  const normalizedSource = normalizeText(sourceText);
  const rankedDocuments = rankDocuments(
    availableDocuments,
    normalizedSelection,
  );
  const currentMentions = rankedDocuments.filter((document) =>
    normalizedSource.includes(normalizeText(document.title)),
  );
  const contextualMentions = rankedDocuments.filter((document) =>
    normalizedSelection.includes(normalizeText(document.title)),
  );
  const firstScore = rankedDocuments[0]
    ? scoreDocument(rankedDocuments[0], normalizedSelection)
    : 0;
  const secondScore = rankedDocuments[1]
    ? scoreDocument(rankedDocuments[1], normalizedSelection)
    : 0;
  const hasClearWinner =
    firstScore >= 20 && firstScore >= secondScore + 10;
  const preferredIds = new Set(preferredSpreadsheetIds);
  const preferredDocuments = rankedDocuments.filter((document) =>
    preferredIds.has(document.spreadsheetId),
  );
  const fallbackDocuments = hasClearWinner
    ? rankedDocuments.slice(0, 1)
    : rankedDocuments;
  const indicatedDocuments = uniqueDocuments([
    ...currentMentions,
    ...preferredDocuments,
    ...contextualMentions,
  ]);
  const candidates = (
    indicatedDocuments.length ? indicatedDocuments : fallbackDocuments
  ).slice(0, MAX_DOCUMENTS);
  const inspectedDocuments: InspectedSpreadsheet[] = [];

  for (const candidate of candidates) {
    const metadata = await adapter.getSpreadsheetMetadata(
      candidate.spreadsheetId,
    );
    inspectedDocuments.push(
      await inspectSpreadsheet(adapter, metadata, contextText, {
        metadataOnly,
      }),
    );
  }

  return {
    availableDocuments: availableDocuments.slice(0, 50),
    inspectedDocuments,
  };
}

export async function inspectSpreadsheet(
  adapter: GoogleSheetsAdapter,
  metadata: ExistingSpreadsheetMetadata,
  focusText = "",
  { metadataOnly = false }: { metadataOnly?: boolean } = {},
): Promise<InspectedSpreadsheet> {
  const tabs: InspectedSheetTab[] = [];
  const rankedTabs = [...metadata.tabs].sort(
    (left, right) =>
      scoreTab(right.title, normalizeText(focusText)) -
      scoreTab(left.title, normalizeText(focusText)),
  );
  const instructionTab = rankedTabs.find((tab) =>
    /инструкц.*ассистент/iu.test(tab.title),
  );
  const selectedTabs = [
    ...(instructionTab ? [instructionTab] : []),
    ...rankedTabs.filter((tab) => tab !== instructionTab),
  ].slice(
    0,
    metadataOnly ? MAX_METADATA_TABS_PER_DOCUMENT : MAX_TABS_PER_DOCUMENT,
  );

  for (const tab of selectedTabs) {
    const rowCount = Math.max(
      1,
      Math.min(tab.rowCount, MAX_SAMPLE_ROWS),
    );
    const columnCount = Math.max(
      1,
      Math.min(tab.columnCount, MAX_SAMPLE_COLUMNS),
    );
    const range = `${quoteSheetTitle(tab.title)}!A1:${columnName(columnCount)}${rowCount}`;

    if (metadataOnly) {
      tabs.push({
        title: tab.title,
        range,
        values: [],
        profile: buildSheetProfile({
          spreadsheet: metadata,
          tab,
          values: [],
        }),
        entities: [],
        rowMatches: [],
      });
      continue;
    }

    try {
      const sample = await adapter.readRange({
        spreadsheetId: metadata.spreadsheetId,
        range,
      });
      const gridMetadata = await safelyReadGridMetadata(
        adapter,
        metadata.spreadsheetId,
        range,
      );
      const profile = buildSheetProfile({
        spreadsheet: metadata,
        tab,
        values: sample.values,
        gridMetadata,
      });
      const entities = buildSheetRowEntities(profile, sample.values);

      tabs.push({
        title: tab.title,
        range: sample.range,
        values: sample.values,
        profile,
        entities,
        rowMatches: focusText
          ? matchSheetRows(focusText, entities).slice(0, 3)
          : [],
      });
    } catch {
      const profile = buildSheetProfile({
        spreadsheet: metadata,
        tab,
        values: [],
      });

      tabs.push({
        title: tab.title,
        range,
        values: [],
        profile,
        entities: [],
        rowMatches: [],
      });
    }
  }

  return {
    spreadsheetId: metadata.spreadsheetId,
    title: metadata.title,
    spreadsheetUrl: metadata.spreadsheetUrl,
    tabs,
  };
}

export function formatGoogleSheetsWorkspaceContext(
  context: GoogleSheetsWorkspaceContext,
  { includeAvailableDocuments = true }: { includeAvailableDocuments?: boolean } = {},
) {
  const available = includeAvailableDocuments
    ? context.availableDocuments
        .filter(
          (document) =>
            !context.inspectedDocuments.some(
              (inspected) =>
                inspected.spreadsheetId === document.spreadsheetId,
            ),
        )
        .slice(0, 30)
        .map(
          (document) =>
            `- ${document.title} [spreadsheet_id=${document.spreadsheetId}]`,
        )
    : [];
  const availableBlock = available.length
    ? ["Другие доступные Google Sheets:", ...available]
        .join("\n")
        .slice(0, 2_000)
    : "";
  const inspectedBudget = Math.max(
    4_000,
    MAX_CONTEXT_CHARACTERS - availableBlock.length - 100,
  );
  const documentBudget = Math.max(
    1_200,
    Math.floor(
      inspectedBudget / Math.max(1, context.inspectedDocuments.length),
    ),
  );
  const documentBlocks = context.inspectedDocuments.map((document) =>
    formatInspectedDocument(document, documentBudget),
  );

  return [
    "Самостоятельно прочитанная структура подходящих документов:",
    ...documentBlocks,
    availableBlock,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARACTERS);
}

function uniqueDocuments(documents: ExistingSpreadsheetSummary[]) {
  const seen = new Set<string>();
  return documents.filter((document) => {
    if (seen.has(document.spreadsheetId)) return false;
    seen.add(document.spreadsheetId);
    return true;
  });
}

function formatInspectedDocument(
  document: InspectedSpreadsheet,
  budget: number,
) {
  const header = `Документ: ${document.title}\nspreadsheet_id: ${document.spreadsheetId}`;
  const tabBudget = Math.max(
    350,
    Math.floor((budget - header.length) / Math.max(1, document.tabs.length)),
  );
  const tabs = document.tabs.map((tab) =>
    truncateContextBlock(formatTabContext(tab), tabBudget),
  );

  return truncateContextBlock([header, ...tabs].join("\n"), budget);
}

function formatTabContext(tab: InspectedSheetTab) {
  if (!tab.values.length && !tab.profile.columns.length) {
    return `Лист: ${tab.title}; доступен для целевого чтения: ${tab.range}`;
  }

  const lines = [
    `Лист: ${tab.title}; образец: ${tab.range}`,
    `Назначение: ${tab.profile.purpose}; entity_type: ${tab.profile.entityType}; header_row: ${tab.profile.headerRowNumber}`,
    `Ключевые колонки: ${formatList(tab.profile.keyColumns)}`,
    `Метрики: ${formatList(tab.profile.metricColumns)}`,
    `Статусы: ${formatList(tab.profile.statusColumns)}`,
    `Формулы: ${formatList(tab.profile.formulaColumns)}`,
    `Защищённые колонки: ${formatList(tab.profile.protectedColumns)}`,
    `Политики колонок: ${tab.profile.columns
      .map(
        (column) =>
          `${column.columnLetter}:${column.header}=${column.role}/${column.updatePolicy}`,
      )
      .join("; ")}`,
    ...tab.values.map(
      (row, index) => `${index + 1}: ${row.map(formatCell).join(" | ")}`,
    ),
  ];

  if (tab.rowMatches.length) {
    lines.push(
      "Возможные существующие строки:",
      ...tab.rowMatches.map(
        (match) =>
          `- row=${match.entity.rowNumber}; key=${match.entity.rowKey}; confidence=${match.confidence.toFixed(2)}; evidence=${match.evidence.join(", ")}`,
      ),
      "При уверенном совпадении нельзя создавать новую строку этой сущности.",
    );
  }

  return lines.join("\n");
}

function truncateContextBlock(value: string, limit: number) {
  if (value.length <= limit) return value;
  const headLength = Math.ceil((limit - 3) * 0.7);
  const tailLength = Math.max(0, limit - 3 - headLength);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

function rankDocuments(
  documents: ExistingSpreadsheetSummary[],
  normalizedContext: string,
) {
  return [...documents].sort((left, right) => {
    const scoreDifference =
      scoreDocument(right, normalizedContext) -
      scoreDocument(left, normalizedContext);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return (right.modifiedTime ?? "").localeCompare(
      left.modifiedTime ?? "",
    );
  });
}

function scoreDocument(
  document: ExistingSpreadsheetSummary,
  normalizedContext: string,
) {
  const normalizedTitle = normalizeText(document.title);

  if (normalizedTitle && normalizedContext.includes(normalizedTitle)) {
    return 10_000 + normalizedTitle.length;
  }

  return scoreName(normalizedTitle, normalizedContext);
}

function scoreName(value: string, normalizedContext: string) {
  const tokens = normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 4);

  return tokens.reduce((score, token) => {
    const stem = token.slice(0, Math.min(token.length, 6));
    return score + (normalizedContext.includes(stem) ? 10 : 0);
  }, 0);
}

function scoreTab(value: string, normalizedContext: string) {
  const title = normalizeText(value);
  let score = scoreName(title, normalizedContext);
  const contactIntent = /аккаунт|контакт|карточк|человек|имя|ссылк|созвон|встреч|лид|сделк/.test(
    normalizedContext,
  );
  const outreachIntent = /рассыл|отправ|оффер|сегмент/.test(normalizedContext);

  if (contactIntent && /интервью/.test(title)) score += 80;
  if (contactIntent && /пилот|клиент/.test(title)) score += 35;
  if (contactIntent && /сегмент.*контакт/.test(title)) score += 20;
  if (outreachIntent && /оффер|рассыл/.test(title)) score += 80;
  if (outreachIntent && /сегмент.*контакт/.test(title)) score += 35;
  if (/план|дашборд/.test(title) && (contactIntent || outreachIntent)) score -= 20;

  return score;
}

function normalizeText(value: string) {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function quoteSheetTitle(title: string) {
  return `'${title.replace(/'/g, "''")}'`;
}

function columnName(columnCount: number) {
  let result = "";
  let current = columnCount;

  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }

  return result;
}

function formatCell(value: SheetScalar) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

async function safelyReadGridMetadata(
  adapter: GoogleSheetsAdapter,
  spreadsheetId: string,
  range: string,
) {
  try {
    return await adapter.readSheetGridMetadata({
      spreadsheetId,
      range,
    });
  } catch {
    return undefined;
  }
}

function formatList(values: string[]) {
  return values.length ? values.join(", ") : "нет";
}
