import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantAction } from "../lib/agents/assistant/types";
import {
  executeTickTickAction,
  resolveTaskDueDate,
} from "../lib/executors/ticktick-executor";
import {
  createTickTickAdapter,
  createTickTickAdapterFromEnv,
} from "../lib/integrations/ticktick/ticktick-adapter";
import type {
  TickTickAdapter,
  TickTickProject,
  TickTickProjectData,
  TickTickTask,
} from "../lib/integrations/ticktick/types";

const PROJECTS: TickTickProject[] = [
  { id: "project-1", name: "💼Работа", permission: "write" },
  { id: "project-2", name: "🏠Личное", permission: "write" },
];

function task(
  overrides: Partial<TickTickTask> = {},
): TickTickTask {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Подготовить презентацию",
    priority: 3,
    status: 0,
    ...overrides,
  };
}

function fakeAdapter({
  projectData = {
    "project-1": {
      project: PROJECTS[0],
      tasks: [],
    },
    "project-2": {
      project: PROJECTS[1],
      tasks: [],
    },
  },
  createTask = async (input) =>
    task({
      id: "created-task",
      projectId: input.projectId,
      title: input.title,
      priority: input.priority ?? 0,
      dueDate: input.dueDate,
      timeZone: input.timeZone,
      isAllDay: input.isAllDay,
    }),
  updateTask = async (input) =>
    task({
      id: input.id,
      projectId: input.projectId,
      title: input.title,
      priority: input.priority ?? 0,
      dueDate: input.dueDate,
      timeZone: input.timeZone,
      isAllDay: input.isAllDay,
    }),
  completeTask = async () => undefined,
  moveTask = async () => undefined,
}: {
  projectData?: Record<string, TickTickProjectData>;
  createTask?: TickTickAdapter["createTask"];
  updateTask?: TickTickAdapter["updateTask"];
  completeTask?: TickTickAdapter["completeTask"];
  moveTask?: TickTickAdapter["moveTask"];
} = {}): TickTickAdapter {
  return {
    listProjects: async () => PROJECTS,
    getProjectData: async (projectId) => projectData[projectId],
    createTask,
    updateTask,
    completeTask,
    moveTask,
  };
}

test("uses the documented TickTick Open API endpoints and Bearer token", async () => {
  const calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body?: unknown;
  }> = [];
  const responses = [
    PROJECTS,
    task({ id: "created" }),
    task({ id: "updated", title: "Обновлено" }),
    undefined,
    undefined,
  ];
  const adapter = createTickTickAdapter({
    apiToken: "secret-token",
    fetchImplementation: (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method || "GET",
        authorization: new Headers(init?.headers).get("Authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const response = responses.shift();

      return response === undefined
        ? new Response(null, { status: 204 })
        : Response.json(response);
    }) as typeof fetch,
  });

  await adapter.listProjects();
  await adapter.createTask({
    projectId: "project-1",
    title: "Задача",
    priority: 5,
  });
  await adapter.updateTask({
    id: "task-1",
    projectId: "project-1",
    title: "Обновлено",
  });
  await adapter.completeTask("project-1", "task-1");
  await adapter.moveTask({
    taskId: "task-1",
    fromProjectId: "project-1",
    toProjectId: "project-2",
  });

  assert.ok(
    calls.every(
      (call) => call.authorization === "Bearer secret-token",
    ),
  );
  assert.match(calls[0].url, /\/open\/v1\/project$/);
  assert.match(calls[1].url, /\/open\/v1\/task$/);
  assert.equal(calls[1].method, "POST");
  assert.match(calls[2].url, /\/open\/v1\/task\/task-1$/);
  assert.match(
    calls[3].url,
    /\/project\/project-1\/task\/task-1\/complete$/,
  );
  assert.deepEqual(calls[4].body, [
    {
      taskId: "task-1",
      fromProjectId: "project-1",
      toProjectId: "project-2",
    },
  ]);
});

test("creates one concrete task with deterministic deadline and priority", async () => {
  let createInput:
    | Parameters<TickTickAdapter["createTask"]>[0]
    | undefined;
  const adapter = fakeAdapter({
    createTask: async (input) => {
      createInput = input;
      return task({
        id: "created",
        projectId: input.projectId,
        title: input.title,
      });
    },
  });
  const action: AssistantAction = {
    id: "action-1",
    type: "create_task",
    payload: {
      title: "Подготовить презентацию",
      dueDateText: "к пятнице",
      priority: "high",
      project: "работа",
    },
  };

  const result = await executeTickTickAction(action, adapter, {
    timezone: "Europe/Moscow",
    now: new Date("2026-07-30T12:00:00Z"),
  });

  assert.equal(result?.status, "succeeded");
  assert.deepEqual(createInput, {
    projectId: "project-1",
    title: "Подготовить презентацию",
    priority: 5,
    dueDate: "2026-07-31T00:00:00+0000",
    timeZone: "Europe/Moscow",
    isAllDay: true,
  });
});

test("does not create a duplicate task in the selected list", async () => {
  let createCalls = 0;
  const adapter = fakeAdapter({
    projectData: {
      "project-1": {
        project: PROJECTS[0],
        tasks: [task({ title: "  Подготовить   презентацию " })],
      },
      "project-2": {
        project: PROJECTS[1],
        tasks: [],
      },
    },
    createTask: async (input) => {
      createCalls += 1;
      return task({ title: input.title });
    },
  });
  const result = await executeTickTickAction(
    {
      id: "action-1",
      type: "create_task",
      payload: {
        title: "подготовить презентацию",
        project: "Работа",
      },
    },
    adapter,
  );

  assert.equal(result?.status, "succeeded");
  assert.match(result?.message || "", /Дубль не создан/);
  assert.equal(createCalls, 0);
});

test("asks for a project when context is still ambiguous", async () => {
  const result = await executeTickTickAction(
    {
      id: "action-1",
      type: "create_task",
      payload: { title: "Подготовить презентацию" },
    },
    fakeAdapter(),
    { defaultProjectId: undefined },
  );

  assert.equal(result?.status, "needs_clarification");
  assert.equal(result?.errorCode, "ticktick_project_required");
  assert.match(result?.message || "", /💼Работа/);
  assert.match(result?.message || "", /🏠Личное/);
});

test("updates and moves one unambiguous task", async () => {
  const moves: unknown[] = [];
  const updates: unknown[] = [];
  const adapter = fakeAdapter({
    projectData: {
      "project-1": {
        project: PROJECTS[0],
        tasks: [task()],
      },
      "project-2": {
        project: PROJECTS[1],
        tasks: [],
      },
    },
    moveTask: async (input) => {
      moves.push(input);
    },
    updateTask: async (input) => {
      updates.push(input);
      return task({
        projectId: input.projectId,
        title: input.title,
        priority: input.priority,
      });
    },
  });
  const result = await executeTickTickAction(
    {
      id: "action-1",
      type: "update_task",
      payload: {
        taskTitle: "Подготовить презентацию",
        changes: {
          title: "Подготовить финальную презентацию",
          priority: "urgent",
          project: "Личное",
        },
      },
    },
    adapter,
  );

  assert.equal(result?.status, "succeeded");
  assert.deepEqual(moves, [
    {
      taskId: "task-1",
      fromProjectId: "project-1",
      toProjectId: "project-2",
    },
  ]);
  assert.deepEqual(updates, [
    {
      id: "task-1",
      projectId: "project-2",
      title: "Подготовить финальную презентацию",
      priority: 5,
      dueDate: undefined,
      timeZone: undefined,
      isAllDay: undefined,
    },
  ]);
});

test("completes a task and asks for ID when titles are ambiguous", async () => {
  const completed: Array<[string, string]> = [];
  const unambiguousAdapter = fakeAdapter({
    projectData: {
      "project-1": {
        project: PROJECTS[0],
        tasks: [task()],
      },
      "project-2": {
        project: PROJECTS[1],
        tasks: [],
      },
    },
    completeTask: async (projectId, taskId) => {
      completed.push([projectId, taskId]);
    },
  });
  const action: AssistantAction = {
    id: "action-1",
    type: "complete_task",
    payload: { taskTitle: "Подготовить презентацию" },
  };
  const completedResult = await executeTickTickAction(
    action,
    unambiguousAdapter,
  );

  assert.equal(completedResult?.status, "succeeded");
  assert.deepEqual(completed, [["project-1", "task-1"]]);

  const ambiguousResult = await executeTickTickAction(
    action,
    fakeAdapter({
      projectData: {
        "project-1": {
          project: PROJECTS[0],
          tasks: [task()],
        },
        "project-2": {
          project: PROJECTS[1],
          tasks: [
            task({
              id: "task-2",
              projectId: "project-2",
            }),
          ],
        },
      },
    }),
  );

  assert.equal(ambiguousResult?.status, "needs_clarification");
  assert.equal(ambiguousResult?.errorCode, "task.id");
});

test("lists open TickTick tasks across projects with useful details", async () => {
  const result = await executeTickTickAction(
    {
      id: "action-1",
      type: "list_tasks",
      payload: { limit: 10 },
    },
    fakeAdapter({
      projectData: {
        "project-1": {
          project: PROJECTS[0],
          tasks: [
            task({
              id: "task-work",
              title: "Подготовить оффер",
              dueDate: "2026-08-02T00:00:00+0000",
              priority: 5,
            }),
          ],
        },
        "project-2": {
          project: PROJECTS[1],
          tasks: [
            task({
              id: "task-personal",
              projectId: "project-2",
              title: "Купить билеты",
              dueDate: "2026-08-01T00:00:00+0000",
              priority: 1,
            }),
            task({
              id: "task-completed",
              projectId: "project-2",
              title: "Завершённая задача",
              status: 2,
            }),
          ],
        },
      },
    }),
  );

  assert.equal(result?.status, "succeeded");
  assert.match(result?.message || "", /Открытые задачи TickTick/);
  assert.match(result?.message || "", /Купить билеты/);
  assert.match(result?.message || "", /Подготовить оффер/);
  assert.match(result?.message || "", /01\.08\.2026/);
  assert.doesNotMatch(result?.message || "", /Завершённая задача/);
  assert.ok(
    (result?.message || "").indexOf("Купить билеты") <
      (result?.message || "").indexOf("Подготовить оффер"),
  );
});

test("rejects mass process tasks and unclear deadlines", async () => {
  const massResult = await executeTickTickAction(
    {
      id: "action-1",
      type: "create_task",
      payload: {
        title: "Написать 90 людям",
        project: "Работа",
      },
    },
    fakeAdapter(),
  );
  const dateResult = resolveTaskDueDate(
    "когда-нибудь на следующей неделе",
    "Europe/Moscow",
    new Date("2026-07-30T12:00:00Z"),
  );

  assert.equal(massResult?.status, "needs_clarification");
  assert.equal(
    massResult?.errorCode,
    "task_concrete_result_required",
  );
  assert.equal(dateResult.kind, "invalid");
});

test(
  "live token can list TickTick projects without changing data",
  { skip: process.env.RUN_LIVE_TICKTICK_TEST !== "1" },
  async () => {
    const adapter = createTickTickAdapterFromEnv();
    assert.ok(adapter);

    const projects = await adapter.listProjects();
    assert.ok(Array.isArray(projects));
  },
);
