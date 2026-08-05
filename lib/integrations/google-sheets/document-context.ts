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
const MAX_SAMPLE_ROWS = 12;
const MAX_SAMPLE_COLUMNS = 12;
const MAX_CONTEXT_CHARACTERS = 12_000;

export async function inspectGoogleSheetsWorkspace({
  adapter,
  sourceText,
  conversation = [],
}: {
  adapter: GoogleSheetsAdapter;
  sourceText: string;
  conversation?: AssistantConversationMessage[];
}): Promise<GoogleSheetsWorkspaceContext> {
  const availableDocuments = await adapter.listSpreadsheets();
  const contextText = [
    sourceText,
    ...conversation.slice(-12).map((message) => message.text),
  ].join("\n");
  const normalizedContext = normalizeText(contextText);
  const rankedDocuments = rankDocuments(
    availableDocuments,
    normalizedContext,
  );
  const exactMentions = rankedDocuments.filter((document) =>
    normalizedContext.includes(normalizeText(document.title)),
  );
  const firstScore = rankedDocuments[0]
    ? scoreDocument(rankedDocuments[0], normalizedContext)
    : 0;
  const secondScore = rankedDocuments[1]
    ? scoreDocument(rankedDocuments[1], normalizedContext)
    : 0;
  const hasClearWinner =
    firstScore >= 20 && firstScore >= secondScore + 10;
  const candidates = (
    exactMentions.length
      ? exactMentions
      : hasClearWinner
        ? rankedDocuments.slice(0, 1)
        : rankedDocuments
  ).slice(0, MAX_DOCUMENTS);
  const inspectedDocuments: InspectedSpreadsheet[] = [];

  for (const candidate of candidates) {
    const metadata = await adapter.getSpreadsheetMetadata(
      candidate.spreadsheetId,
    );
    inspectedDocuments.push(
      await inspectSpreadsheet(adapter, metadata, contextText),
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
  ].slice(0, MAX_TABS_PER_DOCUMENT);

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
) {
  const lines = [
    "Самостоятельно прочитанная структура подходящих документов:",
  ];

  for (const document of context.inspectedDocuments) {
    lines.push(
      "",
      `Документ: ${document.title}`,
      `spreadsheet_id: ${document.spreadsheetId}`,
    );

    for (const tab of document.tabs) {
      lines.push(`Лист: ${tab.title}; образец: ${tab.range}`);
      lines.push(
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
      );

      for (const [index, row] of tab.values.entries()) {
        lines.push(
          `${index + 1}: ${row.map(formatCell).join(" | ")}`,
        );
      }

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
    }
  }

  lines.push(
    "",
    "Другие доступные Google Sheets:",
    ...context.availableDocuments
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
      ),
  );

  const result = lines.join("\n");

  return result.length <= MAX_CONTEXT_CHARACTERS
    ? result
    : `${result.slice(0, MAX_CONTEXT_CHARACTERS)}\n…контекст документов сокращён`;
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
