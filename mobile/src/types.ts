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
}

export type ModelId = "claude-sonnet-4-6" | "claude-opus-4-8";

export const DEFAULT_MODEL: ModelId = "claude-sonnet-4-6";

export const MODEL_OPTIONS: { id: ModelId; label: string; hint: string }[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "szybszy · tańszy" },
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "najlepszy · wolniejszy" },
];
