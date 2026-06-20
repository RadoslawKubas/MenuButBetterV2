// Klient OpenAI-compatible — tworzony LENIWIE przy pierwszym użyciu, żeby brak klucza
// nie wywalał startu serwera (modele OpenAI/Gemini są opcjonalne, do porównań).
// Google (Gemini) używa TEGO SAMEGO SDK OpenAI, tylko z innym baseURL + GEMINI_API_KEY.
import OpenAI from "openai";
import { usageFromOpenAI, type Usage } from "./usage.ts";
import { track, recordUsage } from "./apiLog.ts";
import { compatProvider, isOpenAiReasoning, apiTag } from "./models.ts";

type CompatProvider = "openai" | "google";

const PROVIDER_CONFIG: Record<CompatProvider, { baseURL?: string; apiKeyEnv: string; label: string }> = {
  openai: { apiKeyEnv: "OPENAI_API_KEY", label: "OpenAI" },
  google: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    label: "Gemini",
  },
};

const clients = new Map<CompatProvider, OpenAI>();

/** Klient OpenAI-compatible dla danego providera (osobny baseURL + klucz). */
export function getOpenAICompatible(provider: CompatProvider): OpenAI {
  const cfg = PROVIDER_CONFIG[provider];
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) throw new Error(`Brak ${cfg.apiKeyEnv} na serwerze — model ${cfg.label} niedostępny.`);
  let c = clients.get(provider);
  if (!c) {
    c = new OpenAI({ apiKey, baseURL: cfg.baseURL, maxRetries: 4 });
    clients.set(provider, c);
  }
  return c;
}

/** Skrót: klient dla konkretnego modelu (po jego providerze). */
export function getClientForModel(model: string): OpenAI {
  return getOpenAICompatible(compatProvider(model));
}

export function getOpenAI(): OpenAI {
  return getOpenAICompatible("openai");
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
  /** Poziom rozumowania dla modeli OpenAI (gpt-5*). Domyślnie "minimal" (tanie zadania);
   *  sędzia laba podaje "high", by ocena była najmocniejsza. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}): Promise<{ json: string | null; usage: Usage }> {
  const openai = getClientForModel(opts.model);
  const tag = apiTag(opts.model);
  const reasoning = isOpenAiReasoning(opts.model); // tylko gpt-5* dostaje reasoning_effort
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: opts.model,
    max_completion_tokens: opts.maxCompletionTokens ?? 2000,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.content },
    ],
    response_format: {
      type: "json_schema",
      // strict tylko dla OpenAI; Gemini (compat) bywa bardziej restrykcyjny → bez strict.
      json_schema: { name: opts.schemaName, strict: reasoning, schema: opts.schema },
    },
  };
  if (reasoning) params.reasoning_effort = opts.reasoningEffort ?? "minimal";
  const resp = await track(tag, opts.op, () => openai.chat.completions.create(params));
  const usage = usageFromOpenAI(opts.model, resp.usage);
  recordUsage(tag, usage.inputTokens, usage.outputTokens, usage.costUsd, opts.model);
  const choice = resp.choices[0];
  return { json: choice?.message?.content ?? null, usage };
}
