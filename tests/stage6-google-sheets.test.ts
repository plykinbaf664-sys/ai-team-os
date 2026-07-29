import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleAccessTokenProvider } from "../lib/integrations/google-sheets/google-auth";
import {
  buildBlueprintRequests,
  createGoogleSheetsAdapter,
} from "../lib/integrations/google-sheets/google-sheets-adapter";
import { createOwnProjectOperationsBlueprint } from "../lib/integrations/google-sheets/launch-tracker-blueprint";

test("refreshes and caches a Google OAuth access token", async () => {
  let calls = 0;
  const provider = createGoogleAccessTokenProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    now: () => 1_000,
    fetchImplementation: (async (_input, init) => {
      calls += 1;
      assert.equal(init?.method, "POST");
      assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get("grant_type"), "refresh_token");

      return Response.json({
        access_token: "access-token",
        expires_in: 3600,
      });
    }) as typeof fetch,
  });

  assert.ok(provider);
  assert.equal(await provider(), "access-token");
  assert.equal(await provider(), "access-token");
  assert.equal(calls, 1);
});

test("builds a complete own-project operations blueprint", () => {
  const blueprint = createOwnProjectOperationsBlueprint(
    "Мой проект",
    "Europe/Moscow",
  );

  assert.equal(blueprint.tabs.length, 3);
  assert.deepEqual(
    blueprint.tabs.map((tab) => tab.title),
    ["Задачи", "Метрики", "Дашборд"],
  );
  assert.equal(blueprint.tabs[0].dropdowns.length, 2);
  assert.equal(blueprint.tabs[2].charts.length, 2);
  assert.equal(blueprint.timeZone, "Europe/Moscow");
});

test("compiles blueprint into valid single-operation batch requests", () => {
  const requests = buildBlueprintRequests(
    createOwnProjectOperationsBlueprint("Мой проект", "Europe/Moscow"),
  ) as Array<Record<string, unknown>>;
  const requestTypes = requests.map((request) => Object.keys(request));

  assert.ok(requestTypes.every((keys) => keys.length === 1));
  assert.ok(requestTypes.some((keys) => keys[0] === "updateCells"));
  assert.ok(requestTypes.some((keys) => keys[0] === "setBasicFilter"));
  assert.ok(requestTypes.some((keys) => keys[0] === "setDataValidation"));
  assert.ok(
    requestTypes.some((keys) => keys[0] === "addConditionalFormatRule"),
  );
  assert.equal(
    requestTypes.filter((keys) => keys[0] === "addChart").length,
    2,
  );
  assert.equal(
    requestTypes.at(-1)?.[0],
    "createDeveloperMetadata",
  );
  assert.match(JSON.stringify(requests), /IFERROR\(D2\/C2;0\)/);
  assert.match(
    JSON.stringify(requests),
    /AND\(\$C2<TODAY\(\);\$C2<>\\"\\";\$E2<>\\"Готово\\"\)/,
  );
  assert.match(JSON.stringify(requests), /\$F2<0,8/);
});

test("creates and marks a spreadsheet idempotently", async () => {
  const calls: Array<{
    url: string;
    method: string;
    body?: unknown;
  }> = [];
  const responses = [
    { files: [] },
    {
      spreadsheetId: "sheet-123",
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/sheet-123/edit",
      properties: { title: "Мой проект" },
    },
    { id: "sheet-123" },
    { replies: [] },
    { id: "sheet-123" },
  ];
  const adapter = createGoogleSheetsAdapter({
    getAccessToken: async () => "access-token",
    fetchImplementation: (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method || "GET",
        body:
          typeof init?.body === "string"
            ? JSON.parse(init.body)
            : undefined,
      });

      return Response.json(responses.shift() ?? {});
    }) as typeof fetch,
  });

  const result = await adapter.createSpreadsheet(
    createOwnProjectOperationsBlueprint("Мой проект", "Europe/Moscow"),
    "request-1",
  );

  assert.equal(result.spreadsheetId, "sheet-123");
  assert.equal(result.reused, false);
  assert.equal(calls.length, 5);
  assert.match(calls[0].url, /drive\/v3\/files/);
  assert.equal(calls[1].method, "POST");
  assert.match(calls[1].url, /sheets\.googleapis\.com\/v4\/spreadsheets$/);
  assert.match(calls[3].url, /:batchUpdate$/);
  assert.deepEqual(
    (calls[2].body as { appProperties: Record<string, string> })
      .appProperties.ai_team_os_state,
    "creating",
  );
  assert.deepEqual(
    (calls[4].body as { appProperties: Record<string, string> })
      .appProperties.ai_team_os_state,
    "complete",
  );
});

test("reuses a spreadsheet with an applied blueprint marker", async () => {
  const urls: string[] = [];
  const responses = [
    {
      files: [
        {
          id: "sheet-existing",
          appProperties: {
            ai_team_os_state: "complete",
          },
        },
      ],
    },
    {
      spreadsheetId: "sheet-existing",
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/sheet-existing/edit",
      properties: { title: "Мой проект" },
      developerMetadata: [
        {
          metadataKey: "ai_team_os_blueprint",
          metadataValue: "own-project-operations-v1:v1",
        },
      ],
    },
    { id: "sheet-existing" },
  ];
  const adapter = createGoogleSheetsAdapter({
    getAccessToken: async () => "access-token",
    fetchImplementation: (async (input) => {
      urls.push(String(input));
      return Response.json(responses.shift() ?? {});
    }) as typeof fetch,
  });

  const result = await adapter.createSpreadsheet(
    createOwnProjectOperationsBlueprint("Мой проект", "Europe/Moscow"),
    "request-1",
  );

  assert.equal(result.reused, true);
  assert.equal(urls.length, 3);
  assert.ok(!urls.some((url) => url.endsWith(":batchUpdate")));
});
