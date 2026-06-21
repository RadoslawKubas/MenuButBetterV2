// JEDNO źródło prawdy o CENACH — używane i przez serwer (liczenie kosztu zdarzeń na żywo), i przez lab
// (przeliczanie statystyk). Dzięki temu nie ma rozjazdów: ten sam cennik + ta sama metoda po obu stronach.
//
// Ceny AI (per token) są w models.ts. Tu: stawki NIE-AI/infra + funkcje liczące koszt z opcjonalnymi
// „override'ami" (ręczna podmiana ceny w labie). Override'y są wspólne: lab je edytuje i wgrywa na serwer
// (POST /admin/price-overrides), serwer trzyma je w DB i stosuje do NOWYCH zdarzeń.
import { MODELS } from "./models.ts";

/** Ręczne podmiany cen: dla modeli `{in,out}` ($/1M tok), dla nie-AI/infra `{value}` (jedn. jak w OTHER_RATES). */
export type PriceOverrides = Record<string, { in?: number; out?: number; value?: number }>;

/** Domyślne stawki NIE-AI / infra — JEDNO źródło prawdy (server + lab). */
export const OTHER_RATES: Record<string, number> = {
  egress: 0.1, // $/GB wysłane (Railway)
  google_places: 17, // $/1000 zapytań
  serper: 0.6, // $/1000 zapytań
  serpapi: 10, // $/1000 zapytań
  storage: 0.25, // $/GB-mies. (cache w Postgresie)
};

/** Providerzy NIE-AI rozliczani PER ZAPYTANIE (reszta — Wikimedia/Openverse/CSE/TripAdvisor — darmowa). */
export const PER_CALL_PROVIDERS = new Set(["google_places", "serper", "serpapi"]);

/** Cena AI per 1M tokenów dla modelu (z uwzględnieniem override'a). */
export function aiPrice(model: string, ov?: PriceOverrides): { in: number; out: number } {
  const base = (MODELS as Record<string, { price: { in: number; out: number } }>)[model]?.price ?? { in: 0, out: 0 };
  const o = ov?.[model];
  return { in: o?.in ?? base.in, out: o?.out ?? base.out };
}

/** Koszt $ wywołania AI z liczby tokenów (in/out) wg cennika + override'ów. */
export function aiTokenCost(model: string, inputTokens: number, outputTokens: number, ov?: PriceOverrides): number {
  const p = aiPrice(model, ov);
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

/** Stawka NIE-AI/infra dla klucza (egress/serper/places/…) z uwzględnieniem override'a. */
export function otherRate(key: string, ov?: PriceOverrides): number {
  return ov?.[key]?.value ?? OTHER_RATES[key] ?? 0;
}

/** Koszt $ wywołań NIE-AI providera (np. Serper) z liczby zapytań wg cennika + override'ów. */
export function apiCallCost(provider: string, calls: number, ov?: PriceOverrides): number {
  return PER_CALL_PROVIDERS.has(provider) ? (calls / 1000) * otherRate(provider, ov) : 0;
}

// --- Wspólny CACHE override'ów (in-memory) ---------------------------------------------------
// Serwer ładuje override'y z DB do tego cache na starcie i po każdym uploadzie z labu; funkcje
// liczące koszt (usage.ts, http.ts) czytają go synchronicznie w gorącej ścieżce.
let overridesCache: PriceOverrides = {};
export function getPriceOverrides(): PriceOverrides {
  return overridesCache;
}
export function setPriceOverridesCache(o: PriceOverrides | null | undefined): void {
  overridesCache = o ?? {};
}
