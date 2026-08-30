const apiKey = process.env.GEMINI_API_KEY?.trim();
const model = process.env.THREADPROOF_AI_MODEL?.trim() || "gemini-3.7-flash";

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is unavailable to the workflow.");
}

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["ok"] },
    provider: { type: "string", enum: ["gemini"] },
  },
  required: ["status", "provider"],
};

const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  },
  body: JSON.stringify({
    model,
    input: [
      {
        type: "text",
        text: "Synthetic ThreadProof CI smoke test. Return exactly the JSON object required by the response schema. Do not add explanation.",
      },
    ],
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema,
    },
  }),
  signal: AbortSignal.timeout(60_000),
});

if (!response.ok) {
  let providerStatus = "unknown";
  try {
    const errorPayload = await response.json();
    if (typeof errorPayload?.error?.status === "string") providerStatus = errorPayload.error.status;
  } catch {
    // Do not print provider response bodies in the live smoke test.
  }
  throw new Error(`Gemini live smoke failed: HTTP ${response.status} (${providerStatus}).`);
}

const payload = await response.json();
const steps = Array.isArray(payload?.steps) ? payload.steps : [];
let text = null;
for (let i = steps.length - 1; i >= 0 && !text; i -= 1) {
  const content = Array.isArray(steps[i]?.content) ? steps[i].content : [];
  for (let j = content.length - 1; j >= 0; j -= 1) {
    if (content[j]?.type === "text" && typeof content[j].text === "string") {
      text = content[j].text;
      break;
    }
  }
}

if (!text) throw new Error("Gemini live smoke returned no text output.");

const value = JSON.parse(text);
if (value?.status !== "ok" || value?.provider !== "gemini") {
  throw new Error("Gemini live smoke returned JSON that did not match the expected schema.");
}

console.log(`Gemini live smoke passed for model ${model}.`);
