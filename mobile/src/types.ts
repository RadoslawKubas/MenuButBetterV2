// Typy menu — lustro schematu z server/src/schema.ts.
// (Docelowo wyniesiemy je do współdzielonego pakietu `shared/`.)

export type DishCategory =
  | "starter"
  | "soup"
  | "salad"
  | "main"
  | "side"
  | "pasta"
  | "pizza"
  | "seafood"
  | "dessert"
  | "drink"
  | "other";

export interface MenuItem {
  original: string;
  translated: string;
  /** Kanoniczna nazwa dania (EN/native) do wyszukiwania zdjęcia — lepsze trafienia globalne. */
  photo_query?: string;
  /** Nazwa dania w języku kraju lokalu — dodatkowy wariant do portali (lokalne trafienia). */
  photo_query_local?: string;
  description: string;
  ingredients: string[];
  allergens: string[];
  category: DishCategory;
  dietary: { vegetarian: boolean; vegan: boolean; gluten_free: boolean };
  spice_level: 0 | 1 | 2 | 3;
  price: string | null;
  currency: string | null;
  /** Rozszerzony opis „więcej info" — dociągany na żądanie i cache'owany. */
  extraInfo?: string | null;
  /** Zdjęcia dania — dociągane (poglądowe w tle, prawdziwe na dotknięcie) i cache'owane. */
  photos?: DishPhotoLite[];
  /** Czy próbowano już dociągnąć PRAWDZIWE zdjęcie z restauracji (na dotknięcie). */
  photosUpgraded?: boolean;
  /** Debug ostatniego wyszukiwania zdjęć dla tego dania (przycisk 🐛). */
  photoDebug?: PhotoDebug;
}

/** Co konkretnie zwróciło API w danym kroku + ocena weryfikacji per zdjęcie. */
export interface PhotoDebugCandidate {
  url: string;
  domain?: string;
  context?: string; // strona, z której pochodzi zdjęcie (gdy znana)
  score?: number; // ocena vision 0..1 (gdy weryfikowano)
  passed?: boolean; // czy przeszło próg
  fromVenue?: boolean; // werdykt „z lokalu"
  fromVenueReason?: string; // DLACZEGO tak/nie (do podglądu)
}
export interface PhotoDebugStep {
  tier: string;
  provider: string;
  query: string;
  returned: number;
  passed?: number;
  candidates?: PhotoDebugCandidate[];
}
export interface PhotoDebug {
  params: Record<string, unknown>;
  steps: PhotoDebugStep[];
  resultCount: number;
}

export interface DishPhotoLite {
  /** Lokalny `file://` (po zcache'owaniu) albo zdalny URL. Tego używa <Image>. */
  url: string;
  source: string;
  attribution?: string;
  /** Vision potwierdził, że zdjęcie przedstawia danie. */
  verified?: boolean;
  /** Zdjęcie poglądowe (typ dania), nie z kontekstu lokalu. */
  representative?: boolean;
  /** POTWIERDZONE, że pochodzi z tego lokalu (własna strona lub jego podstrona portalu). */
  fromVenue?: boolean;
  /** DLACZEGO uznano (lub nie) zdjęcie za „z lokalu" — do podglądu w apce. */
  fromVenueReason?: string;
  /** Źródłowy URL zdalny (gdy `url` to lokalny plik) — na wszelki wypadek. */
  remoteUrl?: string;
}

export interface MenuSection {
  name: string;
  name_translated: string;
  items: MenuItem[];
}

export interface Menu {
  restaurant_name: string | null;
  restaurant_address: string | null;
  restaurant_language: string;
  cuisine?: string;
  sections: MenuSection[];
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Skąd wzięliśmy lokalizację skanu. */
export type LocationSource = "device" | "exif" | null;

/** Zużycie tokenów + koszt $ wywołań modeli (licznik kosztów). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export interface TripAdvisorPhoto {
  /** Lokalny `file://` (po zcache'owaniu) albo zdalny URL. */
  url: string;
  caption: string | null;
  /** Źródłowy URL zdalny, gdy `url` to lokalny plik. */
  remoteUrl?: string;
}

export interface TripAdvisorInfo {
  url: string | null;
  rating: number | null;
  reviews: number | null;
  photos: TripAdvisorPhoto[];
}

export interface RestaurantInfo {
  placeId: string;
  name: string;
  address: string | null;
  rating: number | null;
  ratingCount: number | null;
  openNow: boolean | null;
  weekdayHours: string[] | null;
  phone: string | null;
  website: string | null;
  mapsUri: string | null;
  priceLevel: string | null;
  location: GeoPoint | null;
  country: string | null;
  city: string | null;
  photoNames: string[];
  /** Lokalne `file://` zdjęć Google (zrównane z `photoNames`) — po zcache'owaniu. */
  photoUris?: string[];
  tripAdvisor?: TripAdvisorInfo | null;
  /** true = lokal zgadnięty po GPS+kuchni (nie po nazwie) — niepewny, można poprawić. */
  guessedByLocation?: boolean;
  /** Czy nazwa zwróconego lokalu zgadza się z szukaną (Places bywa „najbliższym strzałem").
   *  false → pula zdjęć z lokalu traktowana ostrożniej (Tier 0). */
  nameVerified?: boolean;
}

export type ModelId =
  | "claude-sonnet-4-6"
  | "claude-opus-4-8"
  | "claude-haiku-4-5"
  | "gpt-5"
  | "gpt-5-mini"
  | "gpt-5-nano"
  | "gemini-2.5-flash-lite"
  | "gemini-2.5-flash"
  | "gemini-2.5-pro";

export const DEFAULT_MODEL: ModelId = "claude-sonnet-4-6";

export type ModelProvider = "anthropic" | "openai" | "google";

export const PROVIDER_LABELS: Record<ModelProvider, string> = {
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  google: "Google Gemini",
};

// Provider w apiLog ("claude"/"openai"/"google") — do mapowania statusu klucza z /diagnostics.
export const PROVIDER_DIAG_KEY: Record<ModelProvider, string> = {
  anthropic: "claude",
  openai: "openai",
  google: "google",
};

// Ceny $/1M tokenów — lustro server/src/models.ts (podgląd kosztu przy wyborze modelu).
export const MODEL_OPTIONS: {
  id: ModelId;
  label: string;
  hint: string;
  provider: ModelProvider;
  price: { in: number; out: number };
}[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "zbalansowany", provider: "anthropic", price: { in: 3, out: 15 } },
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "najlepszy", provider: "anthropic", price: { in: 5, out: 25 } },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "najtańszy Claude", provider: "anthropic", price: { in: 1, out: 5 } },
  { id: "gpt-5", label: "GPT-5", hint: "flagowy", provider: "openai", price: { in: 1.25, out: 10 } },
  { id: "gpt-5-mini", label: "GPT-5 mini", hint: "tańszy", provider: "openai", price: { in: 0.25, out: 2 } },
  { id: "gpt-5-nano", label: "GPT-5 nano", hint: "grosze", provider: "openai", price: { in: 0.05, out: 0.4 } },
  { id: "gemini-2.5-flash-lite", label: "Gemini Flash-Lite", hint: "najtaniej", provider: "google", price: { in: 0.1, out: 0.4 } },
  { id: "gemini-2.5-flash", label: "Gemini Flash", hint: "tani vision", provider: "google", price: { in: 0.3, out: 2.5 } },
  { id: "gemini-2.5-pro", label: "Gemini Pro", hint: "najmocniejszy Google", provider: "google", price: { in: 1.25, out: 10 } },
];

// Gotowe zestawy (jeden tap → wszystkie 4 role tym samym modelem) — proste do porównań.
export const MODEL_PRESETS: { id: string; label: string; desc: string; model: ModelId }[] = [
  { id: "cheap", label: "Tani", desc: "Gemini Flash-Lite — grosze", model: "gemini-2.5-flash-lite" },
  { id: "balanced", label: "Zbalansowany", desc: "Sonnet 4.6 wszędzie", model: "claude-sonnet-4-6" },
  { id: "best", label: "Najlepszy", desc: "Opus 4.8 wszędzie", model: "claude-opus-4-8" },
  { id: "gemini", label: "Gemini-test", desc: "Gemini Flash wszędzie", model: "gemini-2.5-flash" },
];

// Języki tłumaczenia menu (wybór w Ustawieniach).
export const LANGUAGES = ["polski", "English", "Deutsch", "Español"];

// Miejsca, w których używamy modelu — każde można skonfigurować osobno (ekran Ustawienia).
export type ModelRole = "scan" | "describe" | "verify" | "venue" | "peek";

export const MODEL_ROLES: { role: ModelRole; label: string; hint: string }[] = [
  { role: "scan", label: "Skan menu", hint: "Odczyt zdjęć menu → pozycje" },
  { role: "describe", label: "Opisy dań", hint: "Rozszerzone „więcej info”" },
  { role: "verify", label: "Weryfikacja zdjęć", hint: "Czy zdjęcie pasuje do dania" },
  { role: "venue", label: "Zdjęcia z lokalu", hint: "Dopasowanie foto z Google / TripAdvisor" },
  { role: "peek", label: "Szybki podgląd (aparat)", hint: "Kuchnia/nazwa na żywo — tani, szybki model" },
];

export const DEFAULT_MODELS: Record<ModelRole, ModelId> = {
  scan: "claude-sonnet-4-6",
  describe: "claude-sonnet-4-6",
  verify: "claude-sonnet-4-6",
  venue: "claude-sonnet-4-6",
  peek: "gpt-5-nano", // szybki podgląd: grosze, działa na kluczu OpenAI (bez billingu Gemini)
};
