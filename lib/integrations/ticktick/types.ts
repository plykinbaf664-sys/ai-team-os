export type TickTickPriority = 0 | 1 | 3 | 5;

export type TickTickProject = {
  id: string;
  name: string;
  closed?: boolean;
  permission?: "read" | "comment" | "write";
};

export type TickTickTask = {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  priority: number;
  status: number;
  createdTime?: string;
  modifiedTime?: string;
  completedTime?: string;
};

export type TickTickProjectData = {
  project: TickTickProject;
  tasks: TickTickTask[];
};

export type TickTickCreateTaskInput = {
  projectId: string;
  title: string;
  content?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  priority?: TickTickPriority;
};

export type TickTickUpdateTaskInput = {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  dueDate?: string;
  timeZone?: string;
  isAllDay?: boolean;
  priority?: TickTickPriority;
};

export type TickTickMoveTaskInput = {
  taskId: string;
  fromProjectId: string;
  toProjectId: string;
};

export interface TickTickAdapter {
  listProjects(): Promise<TickTickProject[]>;
  getProjectData(projectId: string): Promise<TickTickProjectData>;
  createTask(input: TickTickCreateTaskInput): Promise<TickTickTask>;
  updateTask(input: TickTickUpdateTaskInput): Promise<TickTickTask>;
  completeTask(projectId: string, taskId: string): Promise<void>;
  moveTask(input: TickTickMoveTaskInput): Promise<void>;
}
