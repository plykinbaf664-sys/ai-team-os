const UPDATE_TTL_MS = 10 * 60 * 1000;
const MAX_TRACKED_UPDATES = 5_000;
const processedUpdates = new Map<number, number>();

export function isDuplicateTelegramUpdate(updateId: number) {
  const now = Date.now();
  const processedAt = processedUpdates.get(updateId);

  if (processedAt !== undefined && now - processedAt < UPDATE_TTL_MS) {
    return true;
  }

  processedUpdates.set(updateId, now);
  pruneProcessedUpdates(now);

  return false;
}

function pruneProcessedUpdates(now: number) {
  for (const [updateId, processedAt] of processedUpdates) {
    if (now - processedAt >= UPDATE_TTL_MS) {
      processedUpdates.delete(updateId);
    }
  }

  while (processedUpdates.size > MAX_TRACKED_UPDATES) {
    const oldestUpdateId = processedUpdates.keys().next().value;

    if (oldestUpdateId === undefined) {
      return;
    }

    processedUpdates.delete(oldestUpdateId);
  }
}
