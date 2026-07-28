type FetchImplementation = typeof fetch;

type TelegramFileResponse = {
  ok: boolean;
  result?: {
    file_path?: string;
  };
  description?: string;
};

export type DownloadedTelegramVoice = {
  blob: Blob;
  filename: string;
};

export async function downloadTelegramVoice({
  fileId,
  botToken = process.env.TELEGRAM_BOT_TOKEN,
  fetchImplementation = fetch,
}: {
  fileId: string;
  botToken?: string;
  fetchImplementation?: FetchImplementation;
}): Promise<DownloadedTelegramVoice> {
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  }

  const metadataResponse = await fetchImplementation(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const metadata = (await metadataResponse.json()) as TelegramFileResponse;
  const filePath = metadata.result?.file_path;

  if (!metadataResponse.ok || !metadata.ok || !filePath) {
    throw new Error(metadata.description || "Telegram getFile failed.");
  }

  const fileResponse = await fetchImplementation(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`,
  );

  if (!fileResponse.ok) {
    throw new Error(
      `Telegram voice download failed with status ${fileResponse.status}.`,
    );
  }

  const blob = await fileResponse.blob();

  if (!blob.size) {
    throw new Error("Telegram returned an empty voice file.");
  }

  return {
    blob,
    filename: normalizeTelegramVoiceFilename(filePath),
  };
}

function normalizeTelegramVoiceFilename(filePath: string) {
  const filename = filePath.split("/").pop() || "voice.ogg";

  return filename.replace(/\.oga$/i, ".ogg");
}
