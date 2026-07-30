import {
  exchangeTickTickAuthorizationCode,
  getTickTickOAuthConfig,
} from "@/lib/integrations/ticktick/ticktick-oauth";

const STATE_COOKIE = "ticktick_oauth_state";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(
    request.headers.get("cookie"),
    STATE_COOKIE,
  );

  if (error) {
    return htmlResponse(
      "Авторизация TickTick отменена",
      `TickTick вернул ошибку: ${error}`,
      400,
    );
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    return htmlResponse(
      "Ошибка безопасности OAuth",
      "Код или state отсутствует либо не совпадает. Запустите авторизацию заново.",
      400,
    );
  }

  try {
    const accessToken = await exchangeTickTickAuthorizationCode({
      code,
      config: getTickTickOAuthConfig(),
    });

    return htmlResponse(
      "TickTick подключён",
      [
        "Скопируйте строку ниже в .env.local и никому не отправляйте токен:",
        `TICKTICK_ACCESS_TOKEN=${accessToken}`,
        "После сохранения перезапустите сервер.",
      ].join("\n"),
      200,
      true,
    );
  } catch (exchangeError) {
    return htmlResponse(
      "Не удалось получить TickTick access token",
      exchangeError instanceof Error
        ? exchangeError.message
        : "Неизвестная ошибка OAuth.",
      502,
    );
  }
}

function readCookie(header: string | null, name: string) {
  if (!header) {
    return null;
  }

  for (const item of header.split(";")) {
    const [cookieName, ...valueParts] = item.trim().split("=");

    if (cookieName === name) {
      return valueParts.join("=") || null;
    }
  }

  return null;
}

function htmlResponse(
  title: string,
  message: string,
  status: number,
  containsSecret = false,
) {
  const body = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <pre>${escapeHtml(message)}</pre>
    ${containsSecret ? "<p>Закройте эту вкладку после копирования.</p>" : ""}
  </main>
</body>
</html>`;

  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      "Set-Cookie": `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/integrations/ticktick/oauth/callback; Max-Age=0`,
    },
  });
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] || character,
  );
}
