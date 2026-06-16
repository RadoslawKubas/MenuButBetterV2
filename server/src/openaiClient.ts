// Klient OpenAI — tworzony LENIWIE przy pierwszym użyciu, żeby brak OPENAI_API_KEY
// nie wywalał startu serwera (modele OpenAI są opcjonalne, do porównań).
import OpenAI from "openai";
import { usageFromOpenAI, type Usage } from "./usage.ts";
import { track, recordUsage } from "./apiLog.ts";

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Brak OPENAI_API_KEY na serwerze — model OpenAI niedostępny.");
  }
  if (!client) client = new OpenAI({ maxRetries: 4 });
  return client;
}

/**
 * Wspólne wywołanie OpenAI „vision → JSON (structured outputs)" dla zadań wizji
 * (weryfikacja zdjęć, dopasowanie zdjęć z lokalu). `reasoning_effort:"minimal"` — to
 * proste zadania klasyfikacyjne, nie trzeba rozumowania (i tańsze). Zwraca tekst JSON
 * (do JSON.parse) + zużycie tokenów. Loguje do diagnostyki/trwałego logu jako provider openai.
 */
export async function openaiVisionJson(opts: {
  op: string;
  model: string;
  system: string;
  content: OpenAI.Chat.Completions.ChatCompletionContentPart[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxCompletionTokens?: number;
}): Promise<{ json: string | null; usage: Usage }> {
  const openai = getOpenAI();
  const resp = await track("openai", opts.op, () =>
    openai.chat.completions.create({
      model: opts.model,
      reasoning_effort: "minimal",
      max_completion_tokens: opts.maxCompletionTokens ?? 2000,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.content },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
      },
    }),
  );
  const usage = usageFromOpenAI(opts.model, resp.usage);
  recordUsage("openai", usage.inputTokens, usage.outputTokens, usage.costUsd);
  const choice = resp.choices[0];
  return { json: choice?.message?.content ?? null, usage };
}
