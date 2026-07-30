const TELEGRAM_TEXT_LIMIT = 4_000;

export type TelegramFormattedMessage = {
  html: string;
  plain: string;
};

export function formatTelegramMessage(
  sourceText: string,
): TelegramFormattedMessage {
  const normalized = normalizeText(sourceText);
  const sourceLines = normalized.split("\n");
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
    html: truncateByLines(htmlLines, TELEGRAM_TEXT_LIMIT),
    plain: truncateText(
      plainLines.join("\n").trim(),
      TELEGRAM_TEXT_LIMIT,
    ),
  };
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

function truncateByLines(lines: string[], limit: number) {
  const result: string[] = [];
  let length = 0;

  for (const line of lines) {
    const addition = (result.length ? 1 : 0) + line.length;

    if (length + addition > limit - 2) {
      break;
    }

    result.push(line);
    length += addition;
  }

  const truncated = result.length < lines.length;
  const text = result.join("\n").trim();

  return truncated ? `${text}\n…` : text;
}

function truncateText(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit - 2).trimEnd()}\n…`
    : value;
}
