import assert from "node:assert/strict";
import test from "node:test";
import { formatTelegramMessage } from "../lib/telegram/message-format";
import { sendTelegramMessage } from "../lib/telegram/send-message";

test("formats readable and safely escaped Telegram HTML", () => {
  const formatted = formatTelegramMessage(
    [
      "# Отчёт",
      "",
      "**Итог:** значение < 10 & всё работает",
      "- Первый пункт",
      "- `код`",
      "[Таблица](https://docs.google.com/a?x=1&y=2)",
      "\uFFFD",
    ].join("\n"),
  );

  assert.match(formatted.html, /^<b>Отчёт<\/b>/);
  assert.match(formatted.html, /<b>Итог:<\/b>/);
  assert.match(formatted.html, /&lt; 10 &amp;/);
  assert.match(formatted.html, /• Первый пункт/);
  assert.match(formatted.html, /<code>код<\/code>/);
  assert.match(formatted.html, /<a href=/);
  assert.doesNotMatch(formatted.html, /(?:\*\*|�)/);
  assert.doesNotMatch(formatted.plain, /(?:<b>|\*\*|�)/);
});

test("sends HTML and retries as plain text only for entity errors", async () => {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  const bodies: Array<Record<string, unknown>> = [];
  const responses = [
    Response.json(
      {
        ok: false,
        description: "Bad Request: can't parse entities",
      },
      { status: 400 },
    ),
    Response.json({ ok: true, result: { message_id: 789 } }),
  ];

  try {
    const result = await sendTelegramMessage(
      {
        chatId: 123,
        text: "# Заголовок\n\n- Пункт",
        replyToMessageId: 456,
      },
      (async (_input, init) => {
        bodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return (
          responses.shift() ??
          Response.json({ ok: true, result: { message_id: 789 } })
        );
      }) as typeof fetch,
    );
    assert.equal(result.messageId, 789);
  } finally {
    if (previousToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  }

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].parse_mode, "HTML");
  assert.match(String(bodies[0].text), /<b>Заголовок<\/b>/);
  assert.equal(bodies[1].parse_mode, undefined);
  assert.doesNotMatch(String(bodies[1].text), /<b>/);
});
