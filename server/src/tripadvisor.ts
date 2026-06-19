// TripAdvisor Content API: znajdź lokal i pobierz ocenę + REALNY link na jego stronę.
// Darmowe, ale wymaga klucza (TRIPADVISOR_KEY) z zatwierdzonej rejestracji.
import { trackedFetch } from "./apiLog.ts";

const BASE = "https://api.content.tripadvisor.com/api/v1";
const KEY = () => process.env.TRIPADVISOR_KEY;

// Klucz TripAdvisor bywa ograniczony po HTTP referer (a nie po IP — wygodne, gdy serwer
// ma zmienny IP, np. Railway). Gdy ustawisz TRIPADVISOR_REFERER, serwer dokłada ten
// Referer/Origin do zapytań, żeby przejść przez allowlistę.
function taHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const ref = process.env.TRIPADVISOR_REFERER;
  if (ref) {
    h.Referer = ref;
    h.Origin = ref;
  }
  return h;
}

// Języki wspierane przez TripAdvisor Content API. Nieobsługiwane (np. "pl")
// dają 400 w /details — mapujemy je na "en" (ocena/link i tak są niezależne od języka).
const TA_LANGS = new Set([
  "ar", "da", "de", "el", "en", "es", "fr", "it", "iw", "ja", "ko", "nl",
  "no", "pt", "pt_PT", "ru", "sv", "th", "tr", "vi", "zh", "zh_TW",
]);
function taLang(lang?: string): string {
  return lang && TA_LANGS.has(lang) ? lang : "en";
}

export interface TripAdvisorPhoto {
  url: string;
  caption: string | null;
}

export interface TripAdvisorInfo {
  url: string | null; // web_url — strona lokalu na TripAdvisor
  locationId: string | null; // ID wpisu TA tego lokalu — do PEWNEGO werdyktu „z lokalu" (d<id> w URL)
  rating: number | null;
  reviews: number | null;
  photos: TripAdvisorPhoto[]; // prawdziwe zdjęcia lokalu (z podpisami)
}

interface SearchResponse {
  data?: { location_id?: string; name?: string }[];
}

// Normalizacja do dopasowania nazw: małe litery, bez akcentów, tylko alfanumeryczne.
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Wybiera wynik, którego nazwa pasuje do szukanej (zawieranie w obie strony). */
function bestMatch(
  results: { location_id?: string; name?: string }[],
  query: string,
): { location_id?: string; name?: string } | null {
  const needle = norm(query);
  if (!needle) return null;
  for (const r of results) {
    if (!r.name) continue;
    const n = norm(r.name);
    if (n && (n.includes(needle) || needle.includes(n))) return r;
  }
  return null;
}
interface DetailsResponse {
  rating?: string | number;
  num_reviews?: string | number;
  web_url?: string;
}
interface PhotosResponse {
  data?: {
    caption?: string;
    images?: { large?: { url?: string }; medium?: { url?: string } };
  }[];
}

/** Prawdziwe zdjęcia lokalu z TripAdvisor (jedzenie + wnętrze), z podpisami. */
async function fetchPhotos(locId: string, lang: string, key: string): Promise<TripAdvisorPhoto[]> {
  const p = new URL(`${BASE}/location/${locId}/photos`);
  p.searchParams.set("key", key);
  p.searchParams.set("language", lang);
  p.searchParams.set("limit", "20"); // większa pula → więcej realnych zdjęć dań do dopasowania (Tier 0)
  const r = await trackedFetch(p, { headers: taHeaders() });
  if (!r.ok) return [];
  const j = (await r.json()) as PhotosResponse;
  return (j.data ?? [])
    .map((ph) => ({
      url: ph.images?.large?.url ?? ph.images?.medium?.url ?? "",
      caption: ph.caption ?? null,
    }))
    .filter((p) => p.url);
}

export interface TaParams {
  name: string;
  lat?: number;
  lng?: number;
  lang?: string;
}

/** Zwraca dane z TripAdvisor lub null (brak klucza / nie znaleziono). */
export async function findTripAdvisor(params: TaParams): Promise<TripAdvisorInfo | null> {
  const key = KEY();
  if (!key) return null;
  const lang = taLang(params.lang);

  // 1) Location Search — najlepsze dopasowanie po nazwie (+ okolica, jeśli mamy GPS).
  const search = new URL(`${BASE}/location/search`);
  search.searchParams.set("key", key);
  search.searchParams.set("searchQuery", params.name);
  search.searchParams.set("category", "restaurants");
  if (params.lat != null && params.lng != null) {
    search.searchParams.set("latLong", `${params.lat},${params.lng}`);
  }
  search.searchParams.set("language", lang);

  const sres = await trackedFetch(search, { headers: taHeaders() });
  if (!sres.ok) throw new Error(`TripAdvisor search HTTP ${sres.status}: ${await sres.text()}`);
  const sjson = (await sres.json()) as SearchResponse;

  // Dopasowanie po nazwie — TripAdvisor potrafi zwrócić sąsiednie lokale.
  const match = bestMatch(sjson.data ?? [], params.name);
  const locId = match?.location_id;
  if (!locId) return null; // brak realnego dopasowania → nic nie pokazujemy

  // 2) Location Details — ocena, liczba opinii, web_url.
  const det = new URL(`${BASE}/location/${locId}/details`);
  det.searchParams.set("key", key);
  det.searchParams.set("language", lang);

  const dres = await trackedFetch(det, { headers: taHeaders() });
  if (!dres.ok) throw new Error(`TripAdvisor details HTTP ${dres.status}: ${await dres.text()}`);
  const d = (await dres.json()) as DetailsResponse;
  const photos = await fetchPhotos(locId, lang, key).catch(() => []);

  return {
    url: d.web_url ?? null,
    locationId: locId,
    rating: d.rating != null ? Number(d.rating) : null,
    reviews: d.num_reviews != null ? Number(d.num_reviews) : null,
    photos,
  };
}
