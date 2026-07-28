type TelegramAccessInput = {
  userId?: number;
  chatId: number;
};

export type TelegramAccessResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "missing_user"
        | "allowlist_not_configured"
        | "user_not_allowed"
        | "chat_not_allowed";
    };

export function checkTelegramAccess({
  userId,
  chatId,
}: TelegramAccessInput): TelegramAccessResult {
  if (userId === undefined) {
    return { allowed: false, reason: "missing_user" };
  }

  const allowedUserIds = parseIdList(process.env.TELEGRAM_ALLOWED_USER_IDS);
  const allowedChatIds = parseIdList(process.env.TELEGRAM_ALLOWED_CHAT_IDS);

  if (!allowedUserIds.size || !allowedChatIds.size) {
    return { allowed: false, reason: "allowlist_not_configured" };
  }

  if (!allowedUserIds.has(userId)) {
    return { allowed: false, reason: "user_not_allowed" };
  }

  if (!allowedChatIds.has(chatId)) {
    return { allowed: false, reason: "chat_not_allowed" };
  }

  return { allowed: true };
}

function parseIdList(value: string | undefined) {
  const ids = new Set<number>();

  for (const token of value?.split(/[\s,;]+/) ?? []) {
    if (!/^-?\d+$/.test(token)) {
      continue;
    }

    const id = Number(token);

    if (Number.isSafeInteger(id)) {
      ids.add(id);
    }
  }

  return ids;
}
