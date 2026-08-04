import { createHash } from "node:crypto";
import type {
  SheetProfile,
  SheetRowEntity,
  SheetRowMatch,
  SheetScalar,
} from "./types";

export function buildSheetRowEntities(
  profile: SheetProfile,
  values: SheetScalar[][],
): SheetRowEntity[] {
  if (!profile.keyColumns.length) {
    return [];
  }

  const keyIndexes = profile.keyColumns.flatMap((semanticKey) => {
    const column = profile.columns.find(
      (candidate) => candidate.semanticKey === semanticKey,
    );
    return column ? [column.index] : [];
  });

  return values
    .slice(profile.headerRowNumber)
    .flatMap((row, offset): SheetRowEntity[] => {
      const keys = keyIndexes
        .map((index) => formatValue(row[index]))
        .filter(Boolean);

      if (!keys.length) {
        return [];
      }

      const rowKey = keys.join(" | ");
      const normalizedKey = normalizeEntityText(rowKey);
      const rowNumber = profile.headerRowNumber + offset + 1;

      return [
        {
          entityId: createHash("sha256")
            .update(
              [
                profile.spreadsheetId,
                profile.sheetId,
                normalizedKey,
              ].join(":"),
            )
            .digest("hex")
            .slice(0, 24),
          rowNumber,
          rowKey,
          normalizedKey,
          aliases: unique([
            normalizedKey,
            ...keys.map(normalizeEntityText),
          ]),
          values: row,
        },
      ];
    });
}

export function matchSheetRows(
  sourceText: string,
  entities: SheetRowEntity[],
): SheetRowMatch[] {
  const normalizedSource = normalizeEntityText(sourceText);
  const sourceTokens = tokenStems(normalizedSource);

  return entities
    .flatMap((entity): SheetRowMatch[] => {
      let confidence = 0;
      let evidence: string[] = [];

      for (const alias of entity.aliases) {
        if (alias.length >= 3 && normalizedSource.includes(alias)) {
          confidence = Math.max(confidence, 0.98);
          evidence = [`точное совпадение «${alias}»`];
          continue;
        }

        const aliasTokens = tokenStems(alias);
        const overlap = aliasTokens.filter((token) =>
          sourceTokens.includes(token),
        );

        if (!overlap.length) {
          continue;
        }

        const ratio = overlap.length / aliasTokens.length;
        const score = Math.min(0.94, 0.72 + ratio * 0.2);

        if (score > confidence) {
          confidence = score;
          evidence = [`совпали признаки: ${overlap.join(", ")}`];
        }
      }

      return confidence > 0
        ? [{ entity, confidence, evidence }]
        : [];
    })
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        right.entity.rowNumber - left.entity.rowNumber,
    );
}

export function isUnambiguousRowMatch(
  matches: SheetRowMatch[],
  profile: SheetProfile,
) {
  const first = matches[0];
  const second = matches[1];

  return Boolean(
    first &&
      first.confidence >= profile.rowMatchingRules.minimumConfidence &&
      (!second ||
        first.confidence - second.confidence >=
          profile.rowMatchingRules.ambiguityDelta),
  );
}

export function normalizeEntityText(value: string) {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenStems(value: string) {
  return unique(
    value
      .split(" ")
      .filter((token) => token.length >= 4)
      .map((token) => token.slice(0, Math.min(6, token.length))),
  );
}

function formatValue(value: SheetScalar | undefined) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
