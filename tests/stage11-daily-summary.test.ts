import assert from "node:assert/strict";
import test from "node:test";
import {
  createMockActionPlan,
} from "../lib/agents/assistant/assistant-core";
import type { AssistantProjectContext } from "../lib/agents/assistant/project-context";
import {
  composeStrategicResponse,
} from "../lib/agents/assistant/strategic-response-composer";
import type {
  ActionPlan,
  AssistantAction,
} from "../lib/agents/assistant/types";
import {
  executeDailySummaryAction,
} from "../lib/executors/daily-summary-executor";
import type { GoogleCalendarAdapter } from "../lib/integrations/google-calendar/types";
import type { GoogleSheetsAdapter } from "../lib/integrations/google-sheets/types";
import type { TickTickAdapter } from "../lib/integrations/ticktick/types";

const ACTION: Extract<AssistantAction, { type: "generate_daily_summary" }> = {
  id: "action-1",
  type: "generate_daily_summary",
  payload: {},
};

const PLAN: ActionPlan = {
  version: 1,
  mode: "daily_summary",
  sourceText: "Ассистент, дай сводку на сегодня",
  actions: [ACTION],
};

test("builds one management summary from tasks, calendar and sheets", async () => {
  let writeCalls = 0;
  const result = await executeDailySummaryAction(
    ACTION,
    PLAN,
    projectContext(),
    {
      tickTickAdapter: tickTickAdapter(),
      calendarAdapter: calendarAdapter(),
      sheetsAdapter: sheetsAdapter(() => {
        writeCalls += 1;
      }),
      now: new Date("2026-08-05T07:00:00Z"),
    },
  );

  assert.equal(result?.status, "succeeded");
  assert.match(result?.message ?? "", /Сводка на 5 августа 2026/);
  assert.match(result?.message ?? "", /Главные приоритеты/);
  assert.match(result?.message ?? "", /Подготовить предложение/);
  assert.match(result?.message ?? "", /Просрочено/);
  assert.match(result?.message ?? "", /Ответить клиенту/);
  assert.match(result?.message ?? "", /Зависшие задачи/);
  assert.match(result?.message ?? "", /Разобрать гипотезу/);
  assert.match(result?.message ?? "", /Созвон с Мариной — 10:00–11:00/);
  assert.match(result?.message ?? "", /План-факт и процессы/);
  assert.match(result?.message ?? "", /33% плана отправок/);
  assert.equal(writeCalls, 0);
});

test("returns a useful partial summary when one integration fails", async () => {
  const brokenTickTick = tickTickAdapter();
  brokenTickTick.listProjects = async () => {
    throw new Error("temporary failure");
  };
  const result = await executeDailySummaryAction(
    ACTION,
    PLAN,
    projectContext(),
    {
      tickTickAdapter: brokenTickTick,
      calendarAdapter: calendarAdapter(),
      sheetsAdapter: null,
      now: new Date("2026-08-05T07:00:00Z"),
    },
  );

  assert.equal(result?.status, "succeeded");
  assert.match(result?.message ?? "", /Созвон с Мариной/);
  assert.match(result?.message ?? "", /Нет данных из: TickTick, Google Sheets/);
  assert.match(result?.message ?? "", /TickTick временно недоступен/);
});

test("requires a configured timezone without inventing one", async () => {
  const result = await executeDailySummaryAction(
    ACTION,
    PLAN,
    undefined,
    {
      tickTickAdapter: null,
      calendarAdapter: null,
      sheetsAdapter: null,
      defaultTimezone: undefined,
    },
  );

  assert.equal(result?.status, "needs_clarification");
  assert.match(result?.message ?? "", /часовой пояс/iu);
});

test("fallback planner recognizes a natural daily-summary request", () => {
  const outcome = createMockActionPlan("Ассистент, дай сводку на сегодня");

  assert.equal(outcome.kind, "ready");
  if (outcome.kind !== "ready") return;
  assert.equal(outcome.plan.mode, "daily_summary");
  assert.equal(outcome.plan.actions[0].type, "generate_daily_summary");
});

test("response composer preserves the summary sections", () => {
  const text = composeStrategicResponse(PLAN, [
    {
      actionId: ACTION.id,
      actionType: ACTION.type,
      status: "succeeded",
      message: "Сводка на сегодня\n\nГлавное\n- Задача.",
    },
  ]);

  assert.equal(text, "Сводка на сегодня\n\nГлавное\n- Задача.");
});

function projectContext(): AssistantProjectContext {
  return {
    telegramUserId: 1,
    telegramChatId: 2,
    timezone: "Europe/Moscow",
    resolution: "resolved",
    resolutionReason: "configured active project",
    confidence: 1,
    candidates: [],
    activeProject: {
      id: "project-1",
      name: "Запуск магазина ИИ-агентов",
      status: "active",
      stage: "Продажи",
      kpis: [],
      aliases: [],
      resources: [
        {
          id: "resource-1",
          projectId: "project-1",
          resourceType: "google_sheet",
          externalId: "launch",
          title: "Запуск магазина ИИ-агентов — 90 дней",
          metadata: {},
        },
      ],
      glossary: [],
      operatingRules: [],
      decisions: [],
      recentActions: [
        {
          actionType: "update_sheet",
          status: "succeeded",
          payload: {},
          createdAt: "2026-08-05T06:00:00Z",
        },
      ],
    },
  };
}

function tickTickAdapter(): TickTickAdapter {
  return {
    listProjects: async () => [{ id: "sales", name: "Активные сделки" }],
    getProjectData: async () => ({
      project: { id: "sales", name: "Активные сделки" },
      tasks: [
        {
          id: "overdue",
          projectId: "sales",
          title: "Ответить клиенту",
          dueDate: "2026-08-04T09:00:00+03:00",
          priority: 1,
          status: 0,
        },
        {
          id: "priority",
          projectId: "sales",
          title: "Подготовить предложение",
          dueDate: "2026-08-05T18:00:00+03:00",
          priority: 5,
          status: 0,
        },
        {
          id: "stale",
          projectId: "sales",
          title: "Разобрать гипотезу",
          modifiedTime: "2026-07-20T09:00:00+03:00",
          priority: 0,
          status: 0,
        },
      ],
    }),
    createTask: async () => {
      throw new Error("write not allowed");
    },
    updateTask: async () => {
      throw new Error("write not allowed");
    },
    completeTask: async () => {
      throw new Error("write not allowed");
    },
    moveTask: async () => {
      throw new Error("write not allowed");
    },
  };
}

function calendarAdapter(): GoogleCalendarAdapter {
  return {
    getCalendar: async () => ({ id: "primary", summary: "Основной" }),
    listEvents: async () => [
      {
        id: "event-1",
        calendarId: "primary",
        title: "Созвон с Мариной",
        start: { dateTime: "2026-08-05T10:00:00+03:00" },
        end: { dateTime: "2026-08-05T11:00:00+03:00" },
      },
    ],
    getEvent: async () => {
      throw new Error("not used");
    },
    createEvent: async () => {
      throw new Error("write not allowed");
    },
    updateEvent: async () => {
      throw new Error("write not allowed");
    },
  };
}

function sheetsAdapter(onWrite: () => void): GoogleSheetsAdapter {
  return {
    listSpreadsheets: async () => [
      {
        spreadsheetId: "launch",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/launch",
        title: "Запуск магазина ИИ-агентов — 90 дней",
      },
    ],
    findSpreadsheetsByTitle: async () => [],
    getSpreadsheetMetadata: async () => ({
      spreadsheetId: "launch",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/launch",
      title: "Запуск магазина ИИ-агентов — 90 дней",
      tabs: [
        {
          sheetId: 1,
          title: "ОФФЕРЫ И РАССЫЛКИ",
          rowCount: 20,
          columnCount: 6,
          frozenRowCount: 1,
          frozenColumnCount: 0,
        },
      ],
    }),
    readRange: async ({ spreadsheetId, range }) => ({
      spreadsheetId,
      range,
      values: [
        [
          "Сегмент",
          "План отправок",
          "Фактические отправки",
          "Ответы",
          "Дата обновления",
          "Статус и комментарий",
        ],
        ["Партнёры", 30, 10, 1, "2026-07-20", "В работе"],
      ],
    }),
    readSheetGridMetadata: async () => ({
      spreadsheetId: "launch",
      sheetId: 1,
      sheetName: "ОФФЕРЫ И РАССЫЛКИ",
      formulaColumns: [],
      protectedColumns: [],
    }),
    createSpreadsheet: async () => {
      onWrite();
      throw new Error("write not allowed");
    },
    createSheetTab: async () => {
      onWrite();
      throw new Error("write not allowed");
    },
    appendRows: async () => {
      onWrite();
      throw new Error("write not allowed");
    },
    updateCells: async () => {
      onWrite();
      throw new Error("write not allowed");
    },
    clearRange: async () => {
      onWrite();
      throw new Error("write not allowed");
    },
  };
}
