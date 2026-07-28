import {
  isRootAgentRole,
  isSpecialistAgentRole,
  type AgentRole,
  type RootAgentRole,
} from "./agent-registry";

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

  return isSpecialistAgentRole(targetRole);
}

export function assertRootAgentCall(
  role: AgentRole,
): asserts role is RootAgentRole {
  if (!isRootAgentRole(role)) {
    throw new Error("Only Assistant Agent and Project Agent can be called directly.");
  }
}
