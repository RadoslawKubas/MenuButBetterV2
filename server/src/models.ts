// Centralny rejestr modeli AI — jedno miejsce na: providera (Anthropic/OpenAI), etykietę,
// maks. wyjście i CENNIK ($ / 1M tokenów). Dodanie/edycja modelu = jedna linijka tutaj.
//
// Ceny OpenAI to oficjalne stawki startowe GPT-5 (sierpień 2025); jeśli się zmienią,
// popraw `price` poniżej. Caching ignorujemy (liczymy input po stawce standardowej) —
// nieznaczne zawyżenie kosztu, bezpieczne do porównań.

// Google (Gemini) wchodzi przez endpoint ZGODNY z OpenAI — używa tego samego klienta `openai`
// (inny baseURL + GEMINI_API_KEY). Dlatego "google" traktujemy jak "openai" w ścieżce kodu.
export type Provider = "anthropic" | "openai" | "google";

export interface ModelDef {
  provider: Provider;
  label: string;
  /** Sufit wyjścia (max_tokens / max_completion_tokens). To tylko górny limit. */
  maxOutput: number;
  /** Cennik $ za 1M tokenów. */
  price: { in: number; out: number };
  /** Model NIE przyjmuje parametru `temperature` (API zwraca 400 „deprecated"). Np. Opus 4.8. */
  noTemperature?: boolean;
  /** Długa krawędź (px) zdjęcia DO MODELU, jaką TELEFON ma przygotować pod vision tego modelu. Claude pre-4.7
   *  (Sonnet/Haiku) i tak ścina wewnętrznie do 1568; Opus 4.8 (hi-res) do 2576; OpenAI/Gemini ~2048. Telefon
   *  dociela do tej wartości PRZED wysyłką (mniejszy upload + zero CPU obrazów na serwerze). Koszt tokenów modelu
   *  zależy od WYMIARÓW, nie bajtów — więc to JEST realny sufit czytelności jednej klatki. */
  visionMaxEdge: number;
}

export const MODELS = {
  "claude-sonnet-4-6": { provider: "anthropic", label: "Sonnet 4.6", maxOutput: 64000, price: { in: 3, out: 15 }, visionMaxEdge: 1568 },
  "claude-opus-4-8": { provider: "anthropic", label: "Opus 4.8", maxOutput: 128000, price: { in: 5, out: 25 }, noTemperature: true, visionMaxEdge: 2576 },
  "claude-haiku-4-5": { provider: "anthropic", label: "Haiku 4.5", maxOutput: 64000, price: { in: 1, out: 5 }, visionMaxEdge: 1568 },
  "gpt-5": { provider: "openai", label: "GPT-5", maxOutput: 128000, price: { in: 1.25, out: 10 }, visionMaxEdge: 2048 },
  "gpt-5-mini": { provider: "openai", label: "GPT-5 mini", maxOutput: 128000, price: { in: 0.25, out: 2 }, visionMaxEdge: 2048 },
  "gpt-5-nano": { provider: "openai", label: "GPT-5 nano", maxOutput: 128000, price: { in: 0.05, out: 0.4 }, visionMaxEdge: 2048 },
  "gemini-2.5-flash-lite": { provider: "google", label: "Gemini 2.5 Flash-Lite", maxOutput: 65536, price: { in: 0.1, out: 0.4 }, visionMaxEdge: 2048 },
  "gemini-2.5-flash": { provider: "google", label: "Gemini 2.5 Flash", maxOutput: 65536, price: { in: 0.3, out: 2.5 }, visionMaxEdge: 2048 },
  "gemini-2.5-pro": { provider: "google", label: "Gemini 2.5 Pro", maxOutput: 65536, price: { in: 1.25, out: 10 }, visionMaxEdge: 2048 },
} as const satisfies Record<string, ModelDef>;

export type ModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelId = "claude-sonnet-4-6";

export function isModelId(v: unknown): v is ModelId {
  return typeof v === "string" && v in MODELS;
}

function defOf(model: string): ModelDef | undefined {
  return (MODELS as Record<string, ModelDef>)[model];
}

export function providerOf(model: ModelId): Provider {
  return MODELS[model].provider;
}

/** Długa krawędź (px) zdjęcia DO MODELU dla danego modelu vision (patrz ModelDef.visionMaxEdge).
 *  Nieznany model → bezpieczny domyślny 1568 (sufit Claude pre-4.7). */
export function visionMaxEdge(model: string): number {
  return defOf(model)?.visionMaxEdge ?? 1568;
}

/** Czy model jedzie przez API zgodne z OpenAI (OpenAI SDK): OpenAI ALBO Google/Gemini. */
export function usesOpenAiApi(model: string): boolean {
  const p = defOf(model)?.provider;
  return p === "openai" || p === "google";
}

/** Który klient OpenAI-compatible obsłużyć (różny baseURL/klucz). */
export function compatProvider(model: string): "openai" | "google" {
  return defOf(model)?.provider === "google" ? "google" : "openai";
}

/** Czy to model ROZUMUJĄCY OpenAI (gpt-5*) — wtedy wysyłamy reasoning_effort. Gemini: nie. */
export function isOpenAiReasoning(model: string): boolean {
  return defOf(model)?.provider === "openai";
}

/** Czy model przyjmuje parametr `temperature`. Modele rozumujące OpenAI (gpt-5*) go nie biorą;
 *  część nowych modeli Anthropic (Opus 4.8) ma `temperature` ZDEPRECJONOWANE (API zwraca 400). */
export function supportsTemperature(model: string): boolean {
  if (isOpenAiReasoning(model)) return false;
  return !defOf(model)?.noTemperature;
}

/** Etykieta providera w logu diagnostycznym (apiLog). */
export function apiTag(model: string): "claude" | "openai" | "google" {
  const p = defOf(model)?.provider;
  return p === "anthropic" ? "claude" : p === "google" ? "google" : "openai";
}
