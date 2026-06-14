// Centralny rejestr modeli AI — jedno miejsce na: providera (Anthropic/OpenAI), etykietę,
// maks. wyjście i CENNIK ($ / 1M tokenów). Dodanie/edycja modelu = jedna linijka tutaj.
//
// Ceny OpenAI to oficjalne stawki startowe GPT-5 (sierpień 2025); jeśli się zmienią,
// popraw `price` poniżej. Caching ignorujemy (liczymy input po stawce standardowej) —
// nieznaczne zawyżenie kosztu, bezpieczne do porównań.

export type Provider = "anthropic" | "openai";

export interface ModelDef {
  provider: Provider;
  label: string;
  /** Sufit wyjścia (max_tokens / max_completion_tokens). To tylko górny limit. */
  maxOutput: number;
  /** Cennik $ za 1M tokenów. */
  price: { in: number; out: number };
}

export const MODELS = {
  "claude-sonnet-4-6": { provider: "anthropic", label: "Sonnet 4.6", maxOutput: 64000, price: { in: 3, out: 15 } },
  "claude-opus-4-8": { provider: "anthropic", label: "Opus 4.8", maxOutput: 128000, price: { in: 5, out: 25 } },
  "gpt-5": { provider: "openai", label: "GPT-5", maxOutput: 128000, price: { in: 1.25, out: 10 } },
  "gpt-5-mini": { provider: "openai", label: "GPT-5 mini", maxOutput: 128000, price: { in: 0.25, out: 2 } },
} as const satisfies Record<string, ModelDef>;

export type ModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelId = "claude-sonnet-4-6";

export function isModelId(v: unknown): v is ModelId {
  return typeof v === "string" && v in MODELS;
}

export function providerOf(model: ModelId): Provider {
  return MODELS[model].provider;
}
