type FetchImplementation = typeof fetch;

type OpenAITranscriptionResponse = {
  text?: string;
  language?: string;
  error?: {
    message?: string;
  };
};

export type AudioTranscription = {
  text: string;
  language?: string;
};

export async function transcribeAudio({
  blob,
  filename,
  apiKey = process.env.OPENAI_API_KEY,
  model =
    process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
  fetchImplementation = fetch,
}: {
  blob: Blob;
  filename: string;
  apiKey?: string;
  model?: string;
  fetchImplementation?: FetchImplementation;
}): Promise<AudioTranscription> {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("model", model);
  formData.append("response_format", "json");

  const response = await fetchImplementation(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    },
  );
  const data = (await response.json()) as OpenAITranscriptionResponse;

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
        `OpenAI transcription failed with status ${response.status}.`,
    );
  }

  const text = data.text?.trim();

  if (!text) {
    throw new Error("OpenAI transcription response did not contain text.");
  }

  return {
    text,
    language: data.language,
  };
}
