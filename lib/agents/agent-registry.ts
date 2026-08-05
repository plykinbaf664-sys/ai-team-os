export type RootAgentRole = "assistant" | "project";

export type SpecialistAgentRole =
  | "research"
  | "product"
  | "funnel"
  | "content"
  | "scraper"
  | "copy"
  | "reels";

export type AgentRole = RootAgentRole | SpecialistAgentRole;

export type AgentDefinition = {
  role: AgentRole;
  displayName: string;
  enabled: boolean;
  canDelegate: boolean;
};

export const agentRegistry: Record<AgentRole, AgentDefinition> = {
  assistant: {
    role: "assistant",
    displayName: "Assistant Agent",
    enabled: true,
    canDelegate: false,
  },
  project: {
    role: "project",
    displayName: "Project Agent",
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
    enabled: true,
    canDelegate: false,
  },
  funnel: {
    role: "funnel",
    displayName: "Funnel Agent",
    enabled: true,
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

export function isRootAgentRole(role: AgentRole): role is RootAgentRole {
  return role === "assistant" || role === "project";
}

export function isSpecialistAgentRole(role: AgentRole): role is SpecialistAgentRole {
  return !isRootAgentRole(role);
}
