import type {
  TickTickAdapter,
  TickTickCreateTaskInput,
  TickTickMoveTaskInput,
  TickTickProject,
  TickTickProjectData,
  TickTickTask,
  TickTickUpdateTaskInput,
} from "./types";

const TICKTICK_API = "https://api.ticktick.com/open/v1";

type FetchImplementation = typeof fetch;

type TickTickErrorResponse = {
  errorMessage?: string;
  message?: string;
};

export function createTickTickAdapter({
  apiToken,
  fetchImplementation = fetch,
}: {
  apiToken: string;
  fetchImplementation?: FetchImplementation;
}): TickTickAdapter {
  if (!apiToken.trim()) {
    throw new Error("TickTick API token is required.");
  }

  async function request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetchImplementation(`${TICKTICK_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const responseText = await response.text();
    const data = responseText
      ? parseJson(responseText)
      : undefined;

    if (!response.ok) {
      const error = isObject(data)
        ? (data as TickTickErrorResponse)
        : undefined;

      throw new Error(
        error?.errorMessage ||
          error?.message ||
          `TickTick API request failed with status ${response.status}.`,
      );
    }

    return data as T;
  }

  return {
    listProjects() {
      return request<TickTickProject[]>("/project");
    },

    getProjectData(projectId) {
      return request<TickTickProjectData>(
        `/project/${encodeURIComponent(projectId)}/data`,
      );
    },

    createTask(input: TickTickCreateTaskInput) {
      return request<TickTickTask>("/task", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },

    updateTask(input: TickTickUpdateTaskInput) {
      return request<TickTickTask>(
        `/task/${encodeURIComponent(input.id)}`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
    },

    async completeTask(projectId, taskId) {
      await request<void>(
        `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
        { method: "POST" },
      );
    },

    async moveTask(input: TickTickMoveTaskInput) {
      await request<void>("/task/move", {
        method: "POST",
        body: JSON.stringify([input]),
      });
    },
  };
}

export function createTickTickAdapterFromEnv() {
  const apiToken =
    process.env.TICKTICK_ACCESS_TOKEN ||
    process.env.TICKTICK_API_TOKEN;

  return apiToken
    ? createTickTickAdapter({ apiToken })
    : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
