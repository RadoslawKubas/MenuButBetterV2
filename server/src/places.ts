// Integracja z Google Places API (New): znajdź restaurację po nazwie + lokalizacji,
// zwróć ocenę, godziny, kontakt, zdjęcie i kraj/miasto.
import type { TripAdvisorInfo } from "./tripadvisor.ts";
import { trackedFetch } from "./apiLog.ts";

const KEY = () => process.env.GOOGLE_MAPS_KEY;

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
  location: { lat: number; lng: number } | null;
  country: string | null;
  city: string | null;
  /** Rodzaj kuchni/typ lokalu z Google (np. „japanese", „pizza", „sushi") — do listy kandydatów dla vision
   *  i do pokazania na karcie wyszukiwania. Pochodzi z primaryType/types Places. */
  cuisine?: string | null;
  /** Nazwy zasobów zdjęć Google (do proxy /place-photo). */
  photoNames: string[];
  /** Dane z TripAdvisor (ocena + realny link), jeśli skonfigurowane. */
  tripAdvisor?: TripAdvisorInfo | null;
  /** true = lokal zgadnięty po GPS+kuchni (nie po nazwie) — niepewny. */
  guessedByLocation?: boolean;
  /** Czy nazwa zwróconego lokalu zgadza się z szukaną (Places potrafi zwrócić „najbliższy strzał",
   *  więc bez tego pula zdjęć bywa z innego lokalu). false → traktuj zdjęcia jako NIEPEWNE. */
  nameVerified?: boolean;
}

interface FindParams {
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  lang?: string;
}

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.regularOpeningHours",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.priceLevel",
  "places.photos",
  "places.addressComponents",
  "places.primaryType",
  "places.types",
].join(",");

interface PlaceComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}
interface Place {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: { openNow?: boolean; weekdayDescriptions?: string[] };
  nationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  priceLevel?: string;
  photos?: { name?: string }[];
  addressComponents?: PlaceComponent[];
  primaryType?: string;
  types?: string[];
}

function pickComponent(components: PlaceComponent[] | undefined, type: string): string | null {
  return components?.find((c) => c.types?.includes(type))?.longText ?? null;
}

// Czytelna „kuchnia"/typ z Google types (np. „japanese_restaurant" → „japanese", „pizza_restaurant" →
// „pizza"). Generyczne („restaurant"/„food") pomijamy. Do listy kandydatów dla vision i na kartę.
function cuisineFromTypes(primaryType?: string, types?: string[]): string | null {
  const list = [primaryType, ...(types ?? [])].filter((t): t is string => !!t);
  const t = list.find((x) => x.endsWith("_restaurant") && x !== "restaurant") || list.find((x) => !["restaurant", "food", "point_of_interest", "establishment", "store"].includes(x));
  if (!t) return null;
  const label = t.replace(/_restaurant$/, "").replace(/_/g, " ").trim();
  return label || null;
}

function toInfo(p: Place): RestaurantInfo {
  return {
    placeId: p.id,
    name: p.displayName?.text ?? "",
    cuisine: cuisineFromTypes(p.primaryType, p.types),
    address: p.formattedAddress ?? null,
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    openNow: p.regularOpeningHours?.openNow ?? null,
    weekdayHours: p.regularOpeningHours?.weekdayDescriptions ?? null,
    phone: p.nationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    mapsUri: p.googleMapsUri ?? null,
    priceLevel: p.priceLevel ?? null,
    location:
      p.location?.latitude != null && p.location?.longitude != null
        ? { lat: p.location.latitude, lng: p.location.longitude }
        : null,
    country: pickComponent(p.addressComponents, "country"),
    city:
      pickComponent(p.addressComponents, "locality") ??
      pickComponent(p.addressComponents, "postal_town") ??
      pickComponent(p.addressComponents, "administrative_area_level_2"),
    photoNames: (p.photos ?? [])
      .map((ph) => ph.name)
      .filter((n): n is string => !!n)
      .slice(0, 10),
  };
}

// Mapowanie kuchni (PL/EN, free text z menu.cuisine) → ZBIÓR pokrewnych typów Google.
// Pokrewne, bo Google klasyfikuje wąsko (np. „Khan Nawab" to pakistani_restaurant, a nie
// indian_restaurant) — chcemy je trzymać razem, żeby nie wypadały z wyników.
function normCuisine(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
const CUISINE_TYPES: { keys: string[]; types: string[] }[] = [
  {
    keys: ["indyjsk", "indian", "pakistan", "afgan", "afghan", "nepal", "banglad", "hindus", "tikka", "tandoor", "curry"],
    types: ["indian_restaurant", "pakistani_restaurant", "afghani_restaurant", "middle_eastern_restaurant"],
  },
  { keys: ["wlosk", "italian", "pizz"], types: ["italian_restaurant", "pizza_restaurant", "mediterranean_restaurant"] },
  { keys: ["chinsk", "chin", "chinese", "azjat", "asian"], types: ["chinese_restaurant", "asian_restaurant"] },
  { keys: ["japon", "japan", "sushi", "ramen"], types: ["japanese_restaurant", "sushi_restaurant", "ramen_restaurant", "asian_restaurant"] },
  { keys: ["tajsk", "tajland", "thai"], types: ["thai_restaurant", "asian_restaurant"] },
  { keys: ["meksyk", "mexican", "latyno", "latin"], types: ["mexican_restaurant", "latin_american_restaurant"] },
  { keys: ["francus", "french"], types: ["french_restaurant"] },
  { keys: ["hiszpan", "spanish", "tapas"], types: ["spanish_restaurant", "tapas_restaurant", "mediterranean_restaurant"] },
  { keys: ["greck", "greek"], types: ["greek_restaurant", "mediterranean_restaurant"] },
  { keys: ["koreans", "korean"], types: ["korean_restaurant", "asian_restaurant"] },
  { keys: ["wietnam", "vietnam"], types: ["vietnamese_restaurant", "asian_restaurant"] },
  { keys: ["tureck", "turkish", "kebab"], types: ["turkish_restaurant", "middle_eastern_restaurant"] },
  { keys: ["liban", "bliskowschod", "lebanese", "middle eastern", "arab"], types: ["lebanese_restaurant", "middle_eastern_restaurant"] },
  { keys: ["amerykan", "american", "burger"], types: ["american_restaurant", "hamburger_restaurant"] },
  { keys: ["owoce morza", "rybn", "seafood"], types: ["seafood_restaurant"] },
  { keys: ["wegetari", "vegetarian"], types: ["vegetarian_restaurant"] },
  { keys: ["wegan", "vegan"], types: ["vegan_restaurant"] },
];

// Odległość w metrach (haversine) — do wyboru właściwego oddziału sieci po GPS.
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLng = (lng2 - lng1) * p;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Normalizacja nazwy do porównań (małe litery, bez akcentów, tylko alfanumeryczne).
function normName(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}
/** Czy nazwa zwrócona przez Places pasuje do szukanej (zawieranie w obie strony). */
function nameMatches(query: string, candidate: string): boolean {
  const want = normName(query);
  const got = normName(candidate);
  return want.length >= 3 && got.length >= 3 && (got.includes(want) || want.includes(got));
}

/** Zwraca pokrewne typy Google dla opisu kuchni (puste, gdy nie rozpoznano). */
export function cuisineRelatedTypes(cuisine?: string): string[] {
  if (!cuisine) return [];
  const c = normCuisine(cuisine);
  for (const { keys, types } of CUISINE_TYPES) {
    if (keys.some((k) => c.includes(k))) return types;
  }
  return [];
}

interface NearbyParams {
  lat: number;
  lng: number;
  cuisine?: string;
  lang?: string;
  /** Promień poszukiwań w metrach (domyślnie 800; klient może zwiększać). */
  radius?: number;
  max?: number;
}

// KRÓTKI cache wyszukiwań lokalu (Places) — łapie testy/powtórki tego samego lokalu w ciągu paru minut,
// ale szybko wygasa → w realnym życiu „otwarte/zamknięte"/oceny pozostają świeże. In-memory, cap 300.
const lookupCache = new Map<string, { data: unknown; ts: number }>();
const LOOKUP_TTL = 15 * 60_000;
function lookupGet<T>(k: string): T | undefined {
  const hit = lookupCache.get(k);
  if (hit && Date.now() - hit.ts < LOOKUP_TTL) return hit.data as T;
  if (hit) lookupCache.delete(k);
  return undefined;
}
function lookupSet(k: string, data: unknown): void {
  lookupCache.set(k, { data, ts: Date.now() });
  if (lookupCache.size > 300) { const o = lookupCache.keys().next().value; if (o) lookupCache.delete(o); }
}

/**
 * FALLBACK bez nazwy: szuka restauracji W POBLIŻU (po GPS). NIE zawęża sztywno do typu
 * kuchni (Google klasyfikuje wąsko i gubiłby pasujące lokale) — pobiera wszystkie lokale
 * gastronomiczne posortowane po odległości, a następnie wypycha na górę te o pokrewnej
 * kuchni. Dzięki temu właściwy lokal nigdy nie wypada, a trafne są pierwsze.
 */
export async function findRestaurantNearby(params: NearbyParams): Promise<RestaurantInfo[]> {
  const key = KEY();
  if (!key) throw new Error("Brak GOOGLE_MAPS_KEY w środowisku.");

  const lck = `nearby:${params.lat.toFixed(4)},${params.lng.toFixed(4)}:${params.radius ?? 800}:${params.cuisine ?? ""}:${params.lang ?? "pl"}`;
  const cached = lookupGet<RestaurantInfo[]>(lck);
  if (cached) return cached;

  const body: Record<string, unknown> = {
    languageCode: params.lang ?? "pl",
    maxResultCount: Math.min(params.max ?? 20, 20),
    rankPreference: "DISTANCE",
    // Szeroko: restauracje + lokale na wynos/dowóz (nie wykluczamy nic gastronomicznego).
    includedTypes: ["restaurant", "meal_takeaway", "meal_delivery"],
    locationRestriction: {
      circle: {
        center: { latitude: params.lat, longitude: params.lng },
        radius: Math.min(params.radius ?? 800, 50000),
      },
    },
  };

  const res = await trackedFetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Places nearby HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { places?: Place[] };
  let places = json.places ?? [];

  // Stabilne posortowanie: pokrewna kuchnia najpierw (zachowując kolejność po odległości).
  const related = cuisineRelatedTypes(params.cuisine);
  if (related.length > 0) {
    const isRel = (p: Place) =>
      (p.primaryType != null && related.includes(p.primaryType)) ||
      (p.types ?? []).some((t) => related.includes(t));
    places = [...places.filter(isRel), ...places.filter((p) => !isRel(p))];
  }

  const out = places.map((p) => ({ ...toInfo(p), guessedByLocation: true }));
  lookupSet(lck, out);
  return out;
}

/** Znajduje restaurację. Zwraca null, gdy nic nie pasuje. */
export async function findRestaurant(params: FindParams): Promise<RestaurantInfo | null> {
  const key = KEY();
  if (!key) throw new Error("Brak GOOGLE_MAPS_KEY w środowisku.");

  const lck = `find:${params.name}:${params.address ?? ""}:${params.lat?.toFixed(4) ?? ""},${params.lng?.toFixed(4) ?? ""}:${params.lang ?? "pl"}`;
  const cached = lookupGet<RestaurantInfo>(lck);
  if (cached) return cached;

  const hasGeo = params.lat != null && params.lng != null;
  const textQuery = [params.name, "restauracja", params.address].filter(Boolean).join(" ");
  const body: Record<string, unknown> = {
    textQuery,
    languageCode: params.lang ?? "pl",
    // Z GPS bierzemy kilku kandydatów, by wśród oddziałów SIECI wybrać najbliższy (Places domyślnie
    // rankuje po popularności, więc bez tego potrafi wskazać inny oddział tej samej marki).
    maxResultCount: hasGeo ? 8 : 1,
  };
  // Jeśli mamy współrzędne — biasuj wyszukiwanie do okolicy (promień 8 km).
  if (hasGeo) {
    body.locationBias = {
      circle: { center: { latitude: params.lat, longitude: params.lng }, radius: 8000 },
    };
  }

  const res = await trackedFetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Places HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { places?: Place[] };
  const places = json.places ?? [];
  if (places.length === 0) return null;
  let place = places[0]!;
  // SIEĆ: spośród kandydatów PASUJĄCYCH NAZWĄ wybierz NAJBLIŻSZY GPS — to niemal zawsze właściwy
  // oddział (np. Ferretti Badalona 15 m zamiast Ferretti Poblenou 4,9 km). Bez GPS — wynik #0.
  if (hasGeo && places.length > 1) {
    const matching = places.filter((pl) => nameMatches(params.name, pl.displayName?.text ?? ""));
    const pool = matching.length ? matching : places;
    const distOf = (pl: Place): number =>
      pl.location?.latitude != null && pl.location?.longitude != null
        ? haversineM(params.lat!, params.lng!, pl.location.latitude, pl.location.longitude)
        : Infinity;
    place = pool.reduce((best, pl) => (distOf(pl) < distOf(best) ? pl : best), pool[0]!);
  }
  const info = toInfo(place);
  // Places zwraca „najbliższy strzał" nawet przy słabym dopasowaniu nazwy — oznacz, czy nazwa
  // faktycznie pasuje, żeby Tier 0 wiedział, czy może ufać puli zdjęć jako „z tego lokalu".
  info.nameVerified = nameMatches(params.name, info.name);
  lookupSet(lck, info);
  return info;
}

/** Pobiera bajty zdjęcia lokalu (proxy — klucz zostaje po stronie serwera). */
// CACHE bajtów zdjęć lokalu — Places Photo API jest PŁATNE per pobranie, a te same zdjęcia lokalu
// pobierają się wielokrotnie (każda partia /venue-photos + każde /place-photo). Trafienie = ZERO wywołania
// Google. TTL 30 min, cap 300 (proste LRU po kolejności wstawiania). Klucz: nazwa + szerokość.
const placePhotoCache = new Map<string, { body: ArrayBuffer; contentType: string; ts: number }>();
const PLACE_PHOTO_TTL = 30 * 60_000;

export async function fetchPlacePhoto(
  photoName: string,
  maxWidth = 800,
): Promise<{ body: ArrayBuffer; contentType: string }> {
  if (!photoName.startsWith("places/")) throw new Error("Nieprawidłowa nazwa zdjęcia.");
  const ck = `${photoName}@${maxWidth}`;
  const hit = placePhotoCache.get(ck);
  if (hit && Date.now() - hit.ts < PLACE_PHOTO_TTL) return { body: hit.body, contentType: hit.contentType };

  const key = KEY();
  if (!key) throw new Error("Brak GOOGLE_MAPS_KEY.");
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidth}&key=${key}`;
  const res = await trackedFetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Place photo HTTP ${res.status}`);
  const out = { body: await res.arrayBuffer(), contentType: res.headers.get("content-type") ?? "image/jpeg" };
  placePhotoCache.set(ck, { ...out, ts: Date.now() });
  if (placePhotoCache.size > 300) { const oldest = placePhotoCache.keys().next().value; if (oldest) placePhotoCache.delete(oldest); }
  return out;
}
