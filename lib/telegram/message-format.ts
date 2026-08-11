const TELEGRAM_TEXT_LIMIT = 4_000;

export type TelegramFormattedMessage = {
  html: string;
  plain: string;
};

export function formatTelegramMessage(
  sourceText: string,
): TelegramFormattedMessage {
  return formatTelegramMessages(sourceText)[0] ?? { html: "", plain: "" };
}

export function formatTelegramMessages(
  sourceText: string,
): TelegramFormattedMessage[] {
  const normalized = normalizeText(sourceText);
  if (!normalized) return [];

  return splitSourceText(normalized).map(formatSourceChunk);
}

function formatSourceChunk(sourceText: string): TelegramFormattedMessage {
  const sourceLines = sourceText.split("\n");
  const htmlLines: string[] = [];
  const plainLines: string[] = [];
  let firstContentLine = true;
  let previousWasBlank = false;

  for (const sourceLine of sourceLines) {
    const line = sourceLine.trimEnd();

    if (!line.trim()) {
      if (!previousWasBlank && htmlLines.length) {
        htmlLines.push("");
        plainLines.push("");
      }

      previousWasBlank = true;
      continue;
    }

    previousWasBlank = false;
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    const trimmed = line.trim();
    const shouldBoldLine =
      Boolean(heading) ||
      firstContentLine ||
      (/^[^:]{1,80}:$/.test(trimmed) && !bullet && !numbered);

    if (bullet) {
      htmlLines.push(`• ${formatInlineHtml(bullet[1])}`);
      plainLines.push(`• ${formatInlinePlain(bullet[1])}`);
    } else if (numbered) {
      htmlLines.push(
        `${numbered[1]}. ${formatInlineHtml(numbered[2])}`,
      );
      plainLines.push(
        `${numbered[1]}. ${formatInlinePlain(numbered[2])}`,
      );
    } else {
      const content = heading?.[1] ?? trimmed;
      const html = formatInlineHtml(content);
      const plain = formatInlinePlain(content);

      htmlLines.push(
        shouldBoldLine && !/^<b>[\s\S]*<\/b>$/.test(html)
          ? `<b>${html}</b>`
          : html,
      );
      plainLines.push(plain);
    }

    firstContentLine = false;
  }

  return {
    html: htmlLines.join("\n").trim(),
    plain: plainLines.join("\n").trim(),
  };
}

function splitSourceText(sourceText: string) {
  const chunks: string[] = [];
  let current = "";

  for (const block of sourceText.split(/\n{2,}/u)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (fitsTelegramLimit(candidate)) {
      current = candidate;
      continue;
    }

    if (current.trim()) chunks.push(current.trim());
    current = "";

    if (fitsTelegramLimit(block)) {
      current = block;
      continue;
    }

    const parts = splitOversizedBlock(block);
    chunks.push(...parts.slice(0, -1));
    current = parts.at(-1) ?? "";
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function splitOversizedBlock(block: string) {
  const parts: string[] = [];
  let current = "";

  for (const line of block.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (fitsTelegramLimit(candidate)) {
      current = candidate;
      continue;
    }

    if (current.trim()) parts.push(current.trim());
    if (fitsTelegramLimit(line)) {
      current = line;
      continue;
    }

    const lineParts = splitOversizedLine(line);
    parts.push(...lineParts.slice(0, -1));
    current = lineParts.at(-1) ?? "";
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitOversizedLine(line: string) {
  const parts: string[] = [];
  let remaining = line.trim();

  while (remaining && !fitsTelegramLimit(remaining)) {
    let low = 1;
    let high = remaining.length;
    let best = 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fitsTelegramLimit(remaining.slice(0, middle))) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    const preferredBreak = findPreferredBreak(remaining, best);
    parts.push(remaining.slice(0, preferredBreak).trim());
    remaining = remaining.slice(preferredBreak).trimStart();
  }

  if (remaining) parts.push(remaining);
  return parts.filter(Boolean);
}

function findPreferredBreak(value: string, maximum: number) {
  const minimum = Math.floor(maximum * 0.6);
  for (let index = maximum; index >= minimum; index -= 1) {
    if (/\s|[.!?;,:]/u.test(value[index] ?? "")) return index + 1;
  }
  return maximum;
}

function fitsTelegramLimit(sourceText: string) {
  const formatted = formatSourceChunk(sourceText);
  return (
    formatted.html.length <= TELEGRAM_TEXT_LIMIT &&
    formatted.plain.length <= TELEGRAM_TEXT_LIMIT
  );
}

function normalizeText(value: string) {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\uFFFD/g, "")
    .trim();
}

function formatInlineHtml(value: string) {
  return escapeHtml(value)
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2">$1</a>',
    )
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(?:\*\*|__|~~|`)/g, "");
}

function formatInlinePlain(value: string) {
  return value
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
