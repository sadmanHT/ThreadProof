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

export type GeminiErrorCode =
  | "GEMINI_NOT_CONFIGURED"
  | "GEMINI_AUTH_REJECTED"
  | "GEMINI_QUOTA_EXCEEDED"
  | "GEMINI_TIMEOUT"
  | "GEMINI_NETWORK_ERROR"
  | "GEMINI_PROVIDER_UNAVAILABLE"
  | "GEMINI_REQUEST_REJECTED"
  | "GEMINI_INVALID_RESPONSE"
  | "GEMINI_EMPTY_RESPONSE";

export class GeminiProviderError extends Error {
  readonly code: GeminiErrorCode;
  readonly httpStatus: number | null;

  constructor(code: GeminiErrorCode, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "GeminiProviderError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function geminiHttpError(status: number) {
  if (status === 401 || status === 403) {
    return new GeminiProviderError(
      "GEMINI_AUTH_REJECTED",
      "Gemini rejected the configured API credential. Replace it with an active Google AI Studio Gemini API key.",
      status,
    );
  }
  if (status === 429) {
    return new GeminiProviderError(
      "GEMINI_QUOTA_EXCEEDED",
      "Gemini quota or rate limit was reached. Try again later or review the Gemini project quota.",
      status,
    );
  }
  if (status >= 500) {
    return new GeminiProviderError(
      "GEMINI_PROVIDER_UNAVAILABLE",
      "Gemini is temporarily unavailable. Try again later.",
      status,
    );
  }
  return new GeminiProviderError(
    "GEMINI_REQUEST_REJECTED",
    `Gemini rejected the request with HTTP ${status}. Check the configured model and request compatibility.`,
    status,
  );
}

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
  throw new GeminiProviderError("GEMINI_EMPTY_RESPONSE", "Gemini returned no structured text output.");
}

function isTimeoutError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError";
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
  if (!apiKey) {
    throw new GeminiProviderError("GEMINI_NOT_CONFIGURED", "GEMINI_API_KEY is not configured.");
  }

  const model = getAiModel();
  const input: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (document) {
    input.unshift({
      type: "document",
      data: Buffer.from(document.bytes).toString("base64"),
      mime_type: document.mimeType,
    });
  }

  let response: Response;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
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
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new GeminiProviderError("GEMINI_TIMEOUT", "Gemini did not respond before the 60-second timeout.");
    }
    throw new GeminiProviderError("GEMINI_NETWORK_ERROR", "ThreadProof could not reach the Gemini API.");
  }

  if (!response.ok) throw geminiHttpError(response.status);

  let payload: GeminiInteractionResponse;
  try {
    payload = (await response.json()) as GeminiInteractionResponse;
  } catch {
    throw new GeminiProviderError("GEMINI_INVALID_RESPONSE", "Gemini returned a non-JSON response.");
  }

  const text = extractOutputText(payload);
  let value: T;
  try {
    value = JSON.parse(text) as T;
  } catch {
    throw new GeminiProviderError(
      "GEMINI_INVALID_RESPONSE",
      "Gemini returned invalid JSON despite structured-output mode.",
    );
  }

  return {
    id: typeof payload.id === "string" ? payload.id : null,
    model: typeof payload.model === "string" && payload.model ? payload.model : model,
    value,
  };
}
