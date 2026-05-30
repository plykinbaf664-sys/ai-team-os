import type { AgentRole } from "./agent-registry";

type LoopGuardInput = {
  callerRole: AgentRole;
  targetRole: AgentRole;
  depth: number;
};

const MAX_AGENT_DEPTH = 1;

export function canCallAgent({ callerRole, targetRole, depth }: LoopGuardInput) {
  if (depth >= MAX_AGENT_DEPTH) {
    return false;
  }

  if (callerRole !== "project") {
    return false;
  }

  return targetRole !== callerRole;
}

export function assertRootAgentCall(role: AgentRole) {
  if (role !== "project" && role !== "research") {
    throw new Error("Only Project Assistant and Research Agent can be called directly in the MVP.");
  }
}
