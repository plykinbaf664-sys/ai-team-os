import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAssistantProjectContext,
  loadAssistantProjectContext,
  resolveActiveProject,
  type AssistantProjectCandidate,
  type AssistantProjectContextStore,
} from "../lib/agents/assistant/project-context";
import { planAssistantMessage } from "../lib/agents/assistant/assistant-planner";
import { createPersistence } from "../lib/database/persistence";
import type { SupabaseRestClient } from "../lib/database/supabase-rest";

test("resolves the only active project without asking the user", async () => {
  const store = fakeStore({
    getAssistantProjectMemory: async () => ({
      userId: "user-1",
      timezone: "Europe/Moscow",
      projects: [project("launch", "AI Marketplace")],
    }),
  });
  const context = await loadAssistantProjectContext({
    store,
    telegramUserId: 10,
    telegramChatId: 20,
    sourceText: "Внеси результаты рассылок",
  });

  assert.equal(context.resolution, "resolved");
  assert.equal(context.activeProject?.id, "launch");
  assert.equal(context.resolutionReason, "single_active_project");
  assert.equal(context.timezone, "Europe/Moscow");
});

test("uses a linked resource to select one project", () => {
  const selected = resolveActiveProject({
    memory: {
      projects: [
        project("launch", "AI Marketplace", [
          {
            id: "resource-1",
            projectId: "launch",
            resourceType: "google_sheet",
            externalId: "sheet-1",
            title: "Запуск магазина ИИ-агентов — 90 дней",
            metadata: {},
          },
        ]),
        project("consulting", "Консалтинг"),
      ],
    },
    sourceText: "Обнови таблицу Запуск магазина ИИ-агентов — 90 дней",
  });

  assert.equal(selected.kind, "resolved");
  assert.equal(selected.project?.id, "launch");
  assert.equal(selected.reason, "conversation_and_resource_match");
});

test("keeps equal project candidates ambiguous", () => {
  const selected = resolveActiveProject({
    memory: {
      projects: [
        project("one", "Партнёрский запуск"),
        project("two", "Партнёрский аудит"),
      ],
    },
    sourceText: "Обнови партнёрский проект",
  });

  assert.equal(selected.kind, "ambiguous");
  assert.equal(selected.project, undefined);
});

test("an explicit project mention overrides the configured default", () => {
  const selected = resolveActiveProject({
    memory: {
      activeProjectId: "one",
      projects: [
        project("one", "AI Marketplace"),
        project("two", "Консалтинг Дмитрия"),
      ],
    },
    sourceText: "Покажи задачи проекта Консалтинг Дмитрия",
  });

  assert.equal(selected.project?.id, "two");
  assert.equal(selected.reason, "conversation_and_resource_match");
});

test("loads project memory and operational details from persistence", async () => {
  const client = fakeClient({
    select: async (table) => {
      switch (table) {
        case "users":
          return [{ id: "user-1" }];
        case "user_settings":
          return [
            {
              timezone: "Europe/Moscow",
              active_project_id: "project-1",
              preferred_response_style: "Коротко и по делу",
            },
          ];
        case "team_projects":
          return [
            {
              id: "project-1",
              name: "AI Marketplace",
              status: "active",
              metadata: {
                goal: "Запустить продажи",
                stage: "outreach",
                kpis: ["30 отправок", "3 интервью"],
                aliases: ["магазин агентов"],
              },
            },
          ];
        case "project_resources":
          return [
            {
              id: "resource-1",
              project_id: "project-1",
              resource_type: "google_sheet",
              external_id: "sheet-1",
              title: "Запуск магазина ИИ-агентов — 90 дней",
              metadata: {},
            },
          ];
        case "project_glossary":
          return [
            {
              term: "партнёры",
              definition: "Партнёрский сегмент",
              aliases: ["партнёрский аутрич"],
            },
          ];
        case "project_operating_rules":
          return [
            {
              rule_key: "follow_up",
              rule_text: "Follow-up через 3 дня",
              priority: 100,
            },
          ];
        case "assistant_decisions":
          return [
            {
              decision: "Сначала проверить 30 отправок",
              rationale: "Контрольная выборка",
            },
          ];
        case "action_requests":
          return [
            {
              action_type: "update_sheet",
              status: "completed",
              payload: { metric: "actual_sends" },
            },
          ];
        default:
          return [];
      }
    },
  });
  const persistence = createPersistence(client);
  const context = await loadAssistantProjectContext({
    store: persistence,
    telegramUserId: 10,
    telegramChatId: 20,
    sourceText: "Продолжаем",
  });

  assert.equal(context.activeProject?.goal, "Запустить продажи");
  assert.deepEqual(context.activeProject?.kpis, [
    "30 отправок",
    "3 интервью",
  ]);
  assert.equal(context.activeProject?.resources.length, 1);
  assert.equal(context.activeProject?.glossary[0].term, "партнёры");
  assert.equal(context.activeProject?.operatingRules[0].key, "follow_up");
  assert.equal(context.activeProject?.decisions.length, 1);
  assert.equal(context.activeProject?.recentActions.length, 1);
});

test("passes resolved project context to the planner", async () => {
  let plannerInput = "";
  const context = await loadAssistantProjectContext({
    store: fakeStore({
      getAssistantProjectMemory: async () => ({
        activeProjectId: "launch",
        projects: [project("launch", "AI Marketplace")],
      }),
    }),
    telegramUserId: 10,
    telegramChatId: 20,
    sourceText: "Обнови показатели",
  });
  const outcome = await planAssistantMessage("Что по проекту?", {
    apiKey: "test-key",
    projectContext: context,
    fetchImplementation: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input?: string };
      plannerInput = body.input ?? "";
      return Response.json({
        status: "completed",
        output_text: JSON.stringify({
          outcome: {
            kind: "response",
            responseText: "Проект определён.",
          },
        }),
      });
    }) as typeof fetch,
  });

  assert.match(plannerInput, /Активный проект: AI Marketplace/);
  assert.match(plannerInput, /project_id=launch/);
  assert.equal(outcome?.kind, "response");
});

test("formats project rules separately from project facts", async () => {
  const context = await loadAssistantProjectContext({
    store: fakeStore({
      getAssistantProjectDetails: async () => ({
        glossary: [],
        operatingRules: [
          { key: "follow_up", text: "Через 3 дня", priority: 100 },
        ],
        decisions: [],
        recentActions: [],
      }),
    }),
    telegramUserId: 10,
    telegramChatId: 20,
    sourceText: "Продолжаем",
  });
  const formatted = formatAssistantProjectContext(context);

  assert.match(formatted, /Правило \[100\/follow_up\]: Через 3 дня/);
});

function project(
  id: string,
  name: string,
  resources: AssistantProjectCandidate["resources"] = [],
): AssistantProjectCandidate {
  return {
    id,
    name,
    status: "active",
    goal: "Проверить спрос",
    stage: "outreach",
    kpis: ["30 отправок"],
    aliases: [],
    resources,
  };
}

function fakeStore(
  overrides: Partial<AssistantProjectContextStore> = {},
): AssistantProjectContextStore {
  return {
    getAssistantProjectMemory: async () => ({
      projects: [project("launch", "AI Marketplace")],
    }),
    getAssistantProjectDetails: async () => ({
      glossary: [],
      operatingRules: [],
      decisions: [],
      recentActions: [],
    }),
    ...overrides,
  };
}

function fakeClient(
  overrides: Partial<SupabaseRestClient> = {},
): SupabaseRestClient {
  return {
    select: async () => [],
    insert: async () => [],
    upsert: async () => [],
    update: async () => [],
    rpc: async () => null,
    ...overrides,
  };
}
