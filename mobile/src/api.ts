// Klient API backendu. Adres bazowy wykrywamy automatycznie z hosta dev-serwera
// Expo (żeby działało na fizycznym telefonie bez ręcznego wpisywania IP).
import Constants from "expo-constants";
import * as appLog from "./appLog";
import { ZERO_USAGE, type DishPhotoLite, type GeoPoint, type Menu, type ModelId, type PhotoDebug, type RestaurantInfo, type Usage } from "./types";

const API_PORT = 8787;

function resolveApiBase(): string {
  // 1) Ręczne nadpisanie przez zmienną środowiskową (EXPO_PUBLIC_* trafia do appki).
  const override = process.env.EXPO_PUBLIC_API_URL;
  if (override) return override.replace(/\/$/, "");

  // 2) Host maszyny dev z konfiguracji Expo (np. "192.168.1.10:8081").
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig?.debuggerHost as string | undefined);
  if (hostUri) {
    const host = hostUri.split(":")[0];
    return `http://${host}:${API_PORT}`;
  }

  // 3) Ostatnia deska ratunku (symulator).
  return `http://localhost:${API_PORT}`;
}

export const API_BASE = resolveApiBase();

// Token aplikacji (gdy backend w chmurze go wymaga). Wstrzykiwany do buildu przez EAS
// jako EXPO_PUBLIC_APP_TOKEN. Pusty lokalnie → nagłówek nie jest wysyłany (LAN bez tokena).
const APP_TOKEN = process.env.EXPO_PUBLIC_APP_TOKEN ?? "";

/** Nagłówki zapytań JSON + (opcjonalnie) token aplikacji. */
function jsonHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (APP_TOKEN) h["x-app-token"] = APP_TOKEN;
  return h;
}

/** fetch z logowaniem do diagnostyki (czas, ok/błąd) + powiadomieniem o błędzie (toast). */
async function loggedFetch(label: string, input: string, init?: RequestInit): Promise<Response> {
  const t0 = Date.now();
  try {
    const res = await fetch(input, init);
    appLog.logCall({
      ts: Date.now(),
      label,
      ok: res.ok,
      ms: Date.now() - t0,
      detail: res.ok ? undefined : `HTTP ${res.status}`,
    });
    return res;
  } catch (e) {
    appLog.logCall({ ts: Date.now(), label, ok: false, ms: Date.now() - t0, detail: (e as Error).message });
    throw e;
  }
}

export interface ScanImage {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

export interface ScanParams {
  images: ScanImage[];
  targetLang: string;
  restaurantHint?: string;
  /** „Miasto, Kraj" z GPS — daje modelowi pewny kontekst gdzie jest lokal. */
  locationHint?: string;
  model: ModelId;
}

export async function scanMenu(params: ScanParams): Promise<{ menu: Menu; usage: Usage }> {
  const res = await loggedFetch("scan", `${API_BASE}/scan`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      images: params.images.map((i) => ({ base64: i.base64, mediaType: i.mediaType })),
      targetLang: params.targetLang,
      restaurantHint: params.restaurantHint,
      locationHint: params.locationHint,
      model: params.model,
    }),
  });

  const json = (await res.json()) as { menu?: Menu; usage?: Usage; error?: string };
  if (!res.ok || json.error) {
    throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  }
  if (!json.menu) throw new Error("Pusta odpowiedź serwera.");
  return { menu: json.menu, usage: json.usage ?? ZERO_USAGE };
}

export interface DishInfoParams {
  name: string;
  description?: string;
  restaurant?: string;
  cuisine?: string;
  location?: string;
  targetLang: string;
  model: ModelId;
}

export async function fetchDishInfo(
  params: DishInfoParams,
): Promise<{ info: string; usage: Usage }> {
  const res = await loggedFetch("dish-info", `${API_BASE}/dish-info`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { info?: string; usage?: Usage; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  if (!json.info) throw new Error("Pusta odpowiedź serwera.");
  return { info: json.info, usage: json.usage ?? ZERO_USAGE };
}

const LANG_CODES: Record<string, string> = {
  polski: "pl",
  English: "en",
  Deutsch: "de",
  "Español": "es",
};

export interface RestaurantQuery {
  name?: string; // opcjonalna — gdy brak, serwer szuka po GPS + kuchni
  address?: string;
  cuisine?: string;
  location?: GeoPoint | null;
  targetLang?: string;
  forceNearby?: boolean; // wymuś szukanie po okolicy (ignoruje nazwę)
  radius?: number; // zasięg „w pobliżu" w metrach
}

/** Zwraca najlepszy lokal + ewentualnych kandydatów (gdy zgadywano po lokalizacji). */
export async function fetchRestaurant(
  q: RestaurantQuery,
): Promise<{ restaurant: RestaurantInfo | null; candidates: RestaurantInfo[] }> {
  const res = await loggedFetch("restaurant", `${API_BASE}/restaurant`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: q.forceNearby ? undefined : q.name,
      address: q.address,
      cuisine: q.cuisine,
      lat: q.location?.lat,
      lng: q.location?.lng,
      lang: q.targetLang ? LANG_CODES[q.targetLang] ?? "pl" : "pl",
      radius: q.radius,
    }),
  });
  const json = (await res.json()) as {
    restaurant?: RestaurantInfo | null;
    candidates?: RestaurantInfo[];
    error?: string;
  };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return { restaurant: json.restaurant ?? null, candidates: json.candidates ?? [] };
}

/** URL do proxy zdjęcia lokalu (klucz Google zostaje na serwerze). */
export function placePhotoUrl(photoName: string, width = 800): string {
  // Token w query (?t=), bo zdjęcie ładuje <Image>/pobieranie pliku — bez nagłówków.
  const tok = APP_TOKEN ? `&t=${encodeURIComponent(APP_TOKEN)}` : "";
  return `${API_BASE}/place-photo?name=${encodeURIComponent(photoName)}&w=${width}${tok}`;
}

export interface VenueMatch {
  dish: string;
  source: "google" | "tripadvisor";
  photoName?: string; // Google: nazwa zasobu (→ placePhotoUrl)
  url?: string; // TripAdvisor: bezpośredni URL
  caption: string | null;
  confidence: number;
}

/** Tier 0: pula zdjęć z lokalu (Google Places + TripAdvisor) → wizja → ★ dopasowania do dań. */
export async function fetchVenuePhotos(
  photoNames: string[],
  taPhotos: { url: string; caption: string | null }[],
  dishes: string[],
  cuisine?: string,
): Promise<{ matches: VenueMatch[]; usage: Usage }> {
  const res = await loggedFetch("venue-photos", `${API_BASE}/venue-photos`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ photoNames, taPhotos, dishes, cuisine }),
  });
  const json = (await res.json()) as { matches?: VenueMatch[]; usage?: Usage; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return { matches: json.matches ?? [], usage: json.usage ?? ZERO_USAGE };
}

export async function fetchDishPhotos(
  dish: string,
  restaurantHint?: string,
  opts?: { representativeOnly?: boolean; num?: number; cuisine?: string; website?: string; restaurantName?: string; photoQuery?: string },
): Promise<{ photos: DishPhotoLite[]; usage: Usage; debug?: PhotoDebug }> {
  const res = await loggedFetch("dish-photos", `${API_BASE}/dish-photos`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      dish,
      restaurantHint,
      restaurantName: opts?.restaurantName,
      photoQuery: opts?.photoQuery,
      cuisine: opts?.cuisine,
      website: opts?.website,
      num: opts?.num ?? 4,
      representativeOnly: opts?.representativeOnly,
    }),
  });
  const json = (await res.json()) as { photos?: DishPhotoLite[]; usage?: Usage; debug?: PhotoDebug; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return { photos: json.photos ?? [], usage: json.usage ?? ZERO_USAGE, debug: json.debug };
}

// --- Diagnostyka: zewnętrzne API używane przez serwer ---
export interface DiagEntry {
  ts: number;
  op: string;
  ok: boolean;
  ms: number;
  detail?: string;
}
export interface DiagProvider {
  provider: string;
  label: string;
  paid: boolean;
  configured: boolean;
  total: number;
  ok: number;
  errors: number;
  lastAt: number | null;
  lastError: string | null;
  entries: DiagEntry[];
}

/** Pobiera log/statystyki zewnętrznych API z serwera (ekran Diagnostyka). */
export async function fetchDiagnostics(): Promise<{ now: number; providers: DiagProvider[] }> {
  const res = await loggedFetch("diagnostics", `${API_BASE}/diagnostics`, { headers: jsonHeaders() });
  const json = (await res.json()) as { now?: number; providers?: DiagProvider[]; error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? `Błąd serwera (HTTP ${res.status})`);
  return { now: json.now ?? Date.now(), providers: json.providers ?? [] };
}
