// KONFIGURACJA RUNTIME sterowana z LABu (jak override'y cen): modele per-step + włączanie/wyłączanie kroków.
// Cel: testowanie „jak działa" i OSZCZĘDNOŚĆ przy testach — można wyłączyć drogie kroki (wyszukiwanie zdjęć
// per źródło, weryfikacja AI zdjęć, długie opisy). Czysty cache (bez importów z db.ts → bez cyklu); db.ts
// ładuje z app_config (key='runtime_config') i zapisuje. Bez DATABASE_URL działa na samym cache (pusty=domyślne).
import { DEFAULT_MODEL, visionMaxEdge, type ModelId } from "./models.ts";

export type ModelStep = "peek" | "scan" | "enrich" | "verify" | "dishInfo" | "venuePool";
export type ToggleStep = "photoSerper" | "photoSerperPlain" | "photoSerperSite" | "photoSerperPortal" | "photoWikimedia" | "photoOpenverse" | "photoVenue" | "photoVenuePool" | "verifyPhotos" | "descriptions";

export const MODEL_STEPS: ModelStep[] = ["peek", "scan", "enrich", "verify", "dishInfo", "venuePool"];
export const TOGGLE_STEPS: ToggleStep[] = ["photoSerper", "photoSerperPlain", "photoSerperSite", "photoSerperPortal", "photoWikimedia", "photoOpenverse", "photoVenue", "photoVenuePool", "verifyPhotos", "descriptions"];

// Kroki DOMYŚLNIE WYŁĄCZONE (opt-in) — inaczej `stepEnabled` traktuje brak wpisu jako „włączony".
// photoVenuePool: nowa szeroka pula z lokalu (Serper+Google+TA → dania) — włącza się świadomie z LABu,
// żeby deploy nie zmienił zachowania/kosztu wszystkim z automatu.
const DEFAULT_OFF_STEPS: ReadonlySet<ToggleStep> = new Set<ToggleStep>(["photoVenuePool"]);

export interface RuntimeConfig {
  /** Model per krok — nadpisuje model z requestu (apka nie ma już ustawień modeli). */
  models?: Partial<Record<ModelStep, ModelId>>;
  /** Włączenie kroku (brak = włączony). Wyłączony → krok pomijany / zwraca atrapę. */
  steps?: Partial<Record<ToggleStep, boolean>>;
  /** ODCZYT z cache per rodzaj (klucz = CacheKind). brak/true = czyta normalnie; false = ZAWSZE „miss" →
   *  regeneruje/szuka od nowa, ALE wynik DALEJ ZAPISUJE (cache się odświeża/dopełnia). */
  cacheRead?: Record<string, boolean>;
  /** ŻYWOTNOŚĆ (TTL, dni) per rodzaj cache — nadpisuje domyślne TTL_DAYS. Stosowane przy ZAPISIE (nowe/odświeżane
   *  wpisy); brak/0/nie-liczba = TTL domyślny rodzaju. */
  cacheTtl?: Record<string, number>;
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
  venuePool: DEFAULT_MODEL, // szeroka pula z lokalu → dania (vision); model wybierany z LABu
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

/** Czy krok WŁĄCZONY. Domyślnie TAK (wyłączamy jawnie `false`), oprócz kroków OPT-IN (DEFAULT_OFF_STEPS),
 *  które są domyślnie WYŁ i włącza się je jawnie `true`. */
export function stepEnabled(step: ToggleStep): boolean {
  const v = cache.steps?.[step];
  if (v === undefined) return !DEFAULT_OFF_STEPS.has(step);
  return v !== false;
}

/** Czy ODCZYT z danego cache WŁĄCZONY (domyślnie TAK). false → cacheGet udaje „miss"; zapis działa dalej. */
export function cacheReadEnabled(kind: string): boolean {
  return cache.cacheRead?.[kind] !== false;
}

/** Nadpisanie TTL (dni życia) per rodzaj cache z configu (LAB). Zwraca tylko sensowną dodatnią liczbę całkowitą,
 *  inaczej undefined (→ używamy domyślnego TTL_DAYS rodzaju). */
export function cacheTtlOverride(kind: string): number | undefined {
  const v = cache.cacheTtl?.[kind];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

// Jakość JPEG payloadu zdjęcia DO MODELU (telefon koduje z tą jakością). Koszt tokenów modelu zależy od WYMIARÓW,
// nie od jakości/bajtów → wyższa jakość = lepszy OCR „za darmo" po stronie tokenów (rośnie tylko upload).
export const SCAN_IMAGE_QUALITY = 0.85;

/** Zachowania apki (dla /app-config) z domyślnymi: auto-opisy WYŁ, limit dań = wszystkie (0). Dodatkowo SPEC
 *  zdjęć DO MODELU (dł. krawędź + jakość) — telefon dociela do tego PRZED wysyłką, więc apka nie musi znać modelu
 *  (serwer mówi rozmiar) i serwer nie skaluje obrazów. OSOBNO dla DWÓCH miejsc, bo każde idzie INNYM modelem:
 *   • `image*`     = wysyłka skanu (OCR/struktura) → model kroku „scan".
 *   • `peekImage*` = „szybki podgląd" (kuchnia/nazwa) → model kroku „peek" (zwykle tańszy, inny sufit vision). */
export function getAppConfig(): { autoDescriptions: boolean; autoLimit: number; imageMaxEdge: number; imageQuality: number; peekImageMaxEdge: number; peekImageQuality: number } {
  return {
    autoDescriptions: cache.app?.autoDescriptions === true,
    autoLimit: Number.isFinite(cache.app?.autoLimit) && (cache.app!.autoLimit as number) > 0 ? Math.floor(cache.app!.autoLimit as number) : 0,
    imageMaxEdge: visionMaxEdge(cfgModel("scan")),
    imageQuality: SCAN_IMAGE_QUALITY,
    peekImageMaxEdge: visionMaxEdge(cfgModel("peek")),
    peekImageQuality: SCAN_IMAGE_QUALITY,
  };
}

export interface ServerConfigView {
  /** Efektywny model każdego kroku (config LABu > domyślny serwera). */
  models: Record<ModelStep, ModelId>;
  /** Czy każdy krok WŁĄCZONY (po rozwiązaniu domyślnych). */
  steps: Record<ToggleStep, boolean>;
  /** Rodzaje cache z WYŁĄCZONYM odczytem (zawsze „miss" + regeneracja, zapis dalej działa). */
  cacheReadOff: string[];
  /** Zachowania apki sterowane z serwera. */
  app: { autoDescriptions: boolean; autoLimit: number };
}

/** Read-only podgląd EFEKTYWNEJ konfiguracji serwera — apka pokazuje to w Ustawieniach (bez edycji). */
export function getServerConfigView(): ServerConfigView {
  const models = {} as Record<ModelStep, ModelId>;
  for (const s of MODEL_STEPS) models[s] = cfgModel(s);
  const steps = {} as Record<ToggleStep, boolean>;
  for (const s of TOGGLE_STEPS) steps[s] = stepEnabled(s);
  const cacheReadOff = Object.entries(cache.cacheRead ?? {})
    .filter(([, v]) => v === false)
    .map(([k]) => k);
  return { models, steps, cacheReadOff, app: getAppConfig() };
}
