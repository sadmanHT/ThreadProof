import { getAiModel } from "@/lib/ai/policy.server";

export type JsonSchema = Record<string, unknown>;

export type GeminiDocument = {
  bytes: Uint8Array;
  mimeType: "application/pdf";
};

type GeminiInteractionResponse = {
  id?: string;
  model?: string;
  status?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

export type GeminiStructuredResult<T> = {
  id: string | null;
  model: string;
  value: T;
};

function extractOutputText(response: GeminiInteractionResponse) {
  const steps = Array.isArray(response.steps) ? response.steps : [];
  for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    const content = Array.isArray(steps[stepIndex]?.content) ? steps[stepIndex]!.content! : [];
    for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex -= 1) {
      const item = content[contentIndex];
      if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
        return item.text;
      }
    }
  }
  throw new Error("Gemini returned no structured text output.");
}

export async function runGeminiStructured<T>({
  prompt,
  schema,
  document,
}: {
  prompt: string;
  schema: JsonSchema;
  document?: GeminiDocument;
}): Promise<GeminiStructuredResult<T>> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");

  const model = getAiModel();
  const input: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (document) {
    input.unshift({
      type: "document",
      data: Buffer.from(document.bytes).toString("base64"),
      mime_type: document.mimeType,
    });
  }

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model,
      input,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema,
      },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`Gemini API request failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as GeminiInteractionResponse;
  const text = extractOutputText(payload);
  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch {
    throw new Error("Gemini returned invalid JSON despite structured-output mode.");
  }

  return {
    id: typeof payload.id === "string" ? payload.id : null,
    model: typeof payload.model === "string" && payload.model ? payload.model : model,
    value,
  };
}
