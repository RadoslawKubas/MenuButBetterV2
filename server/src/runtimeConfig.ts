// KONFIGURACJA RUNTIME sterowana z LABu (jak override'y cen): modele per-step + włączanie/wyłączanie kroków.
// Cel: testowanie „jak działa" i OSZCZĘDNOŚĆ przy testach — można wyłączyć drogie kroki (wyszukiwanie zdjęć
// per źródło, weryfikacja AI zdjęć, długie opisy). Czysty cache (bez importów z db.ts → bez cyklu); db.ts
// ładuje z app_config (key='runtime_config') i zapisuje. Bez DATABASE_URL działa na samym cache (pusty=domyślne).
import { DEFAULT_MODEL, type ModelId } from "./models.ts";

export type ModelStep = "peek" | "scan" | "enrich" | "verify" | "dishInfo";
export type ToggleStep = "photoSerper" | "photoSerperVenue" | "photoWikimedia" | "photoOpenverse" | "photoVenue" | "verifyPhotos" | "descriptions";

export interface RuntimeConfig {
  /** Model per krok — nadpisuje model z requestu (apka nie ma już ustawień modeli). */
  models?: Partial<Record<ModelStep, ModelId>>;
  /** Włączenie kroku (brak = włączony). Wyłączony → krok pomijany / zwraca atrapę. */
  steps?: Partial<Record<ToggleStep, boolean>>;
  /** Zachowania APKI (dawne „Koszty/Limity" przeniesione na serwer; apka czyta przez /app-config). */
  app?: {
    /** Długie opisy dań generowane OD RAZU po skanie (true) czy dopiero na kliknięcie usera (false=domyślnie). */
    autoDescriptions?: boolean;
    /** Limit dań do auto-dociągania zdjęć po skanie. 0/brak = WSZYSTKIE (domyślnie). */
    autoLimit?: number;
  };
}

let cache: RuntimeConfig = {};

// DOMYŚLNE SERWERA per krok — to JEDYNE źródło prawdy o modelu, gdy config nic nie ustawia. Apka NIE wysyła
// już modeli (i tak ignorowane). peek tani (OpenAI nano), reszta Sonnet.
export const SERVER_DEFAULT_MODELS: Record<ModelStep, ModelId> = {
  peek: "gpt-5-nano",
  scan: DEFAULT_MODEL,
  enrich: DEFAULT_MODEL,
  verify: DEFAULT_MODEL,
  dishInfo: DEFAULT_MODEL,
};

export function getRuntimeConfig(): RuntimeConfig {
  return cache;
}
export function setRuntimeConfigCache(c: RuntimeConfig | null | undefined): void {
  cache = c && typeof c === "object" ? c : {};
}

/** Model dla kroku: config (lab) > DOMYŚLNY SERWERA. Z apki nic nie bierzemy — serwer ustala. */
export function cfgModel(step: ModelStep): ModelId {
  return cache.models?.[step] ?? SERVER_DEFAULT_MODELS[step];
}

/** Czy krok WŁĄCZONY (domyślnie TAK — wyłączamy tylko jawnie `false`). */
export function stepEnabled(step: ToggleStep): boolean {
  return cache.steps?.[step] !== false;
}

/** Zachowania apki (dla /app-config) z domyślnymi: auto-opisy WYŁ, limit dań = wszystkie (0). */
export function getAppConfig(): { autoDescriptions: boolean; autoLimit: number } {
  return {
    autoDescriptions: cache.app?.autoDescriptions === true,
    autoLimit: Number.isFinite(cache.app?.autoLimit) && (cache.app!.autoLimit as number) > 0 ? Math.floor(cache.app!.autoLimit as number) : 0,
  };
}
