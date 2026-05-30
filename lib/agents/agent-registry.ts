export type AgentRole =
  | "project"
  | "research"
  | "product"
  | "funnel"
  | "content"
  | "scraper"
  | "copy"
  | "reels";

export type AgentDefinition = {
  role: AgentRole;
  displayName: string;
  enabled: boolean;
  canDelegate: boolean;
};

export const agentRegistry: Record<AgentRole, AgentDefinition> = {
  project: {
    role: "project",
    displayName: "Project Assistant",
    enabled: true,
    canDelegate: true,
  },
  research: {
    role: "research",
    displayName: "Research Agent",
    enabled: true,
    canDelegate: false,
  },
  product: {
    role: "product",
    displayName: "Product Agent",
    enabled: false,
    canDelegate: false,
  },
  funnel: {
    role: "funnel",
    displayName: "Funnel Agent",
    enabled: false,
    canDelegate: false,
  },
  content: {
    role: "content",
    displayName: "Content Agent",
    enabled: false,
    canDelegate: false,
  },
  scraper: {
    role: "scraper",
    displayName: "Scraper Agent",
    enabled: false,
    canDelegate: false,
  },
  copy: {
    role: "copy",
    displayName: "Copy Agent",
    enabled: false,
    canDelegate: false,
  },
  reels: {
    role: "reels",
    displayName: "Reels Agent",
    enabled: false,
    canDelegate: false,
  },
};

export function getAgent(role: AgentRole) {
  return agentRegistry[role];
}
