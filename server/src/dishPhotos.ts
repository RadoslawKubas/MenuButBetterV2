// Dostawca zdjęć dań — abstrakcja z wymiennym backendem.
// Tryb osobisty: Google Custom Search JSON API (searchType=image) — oficjalne API,
// bez scrapowania HTML. Tryb sklepowy: podmieni się implementację (Places/AI/UGC).
import { trackedFetch } from "./apiLog.ts";

// Polityka Wikimedia: opisowy User-Agent z kontaktem → wyższe limity, mniej 429.
const WIKI_UA = "MenuButBetter/1.0 (https://appwithkiss.com; contact rk@appwithkiss.com)";

// Globalny (na proces) ogranicznik dla Wikimedii: max 2 równolegle + minimalny odstęp,
// żeby seria zapytań (tanie zdjęcia poglądowe dla wielu dań) nie wpadała w 429.
function makeLimiter(maxConcurrent: number, minGapMs: number) {
  let active = 0;
  let nextSlot = 0;
  const queue: (() => void)[] = [];
  const pump = (): void => {
    if (active >= maxConcurrent || queue.length === 0) return;
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + minGapMs;
    active++;
    const run = queue.shift()!;
    setTimeout(run, wait);
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => {
          active--;
          pump();
        });
      });
      pump();
    });
}
const wikiLimit = makeLimiter(2, 150);

/** Fetch do Wikimedii przez ogranicznik + 1 retry na 429 (krótki backoff). */
async function wikiFetch(url: URL): Promise<Response> {
  return wikiLimit(async () => {
    const res = await trackedFetch(url, { headers: { "User-Agent": WIKI_UA } });
    if (res.status !== 429) return res;
    await new Promise((r) => setTimeout(r, 700));
    return trackedFetch(url, { headers: { "User-Agent": WIKI_UA } });
  });
}

export interface DishPhoto {
  url: string;
  source: string;
  attribution?: string;
  /** Strona, z której pochodzi zdjęcie (kontekst/atrybucja). */
  contextUrl?: string;
  /** Domena źródła (np. tripadvisor.com) — do kategoryzacji i etykiety. */
  domain?: string;
}

/** Host z URL-a (bez www), best-effort. */
export function hostOf(u?: string): string | undefined {
  if (!u) return undefined;
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Kategoria źródła zdjęcia (do etykiety + koloru na miniaturce). `restaurant` gdy domena
 * pasuje do strony lokalu; potem znane portale; `wikimedia`/`web` jako reszta.
 */
export function photoSourceCategory(domain?: string, restaurantDomain?: string): string {
  const h = (domain ?? "").toLowerCase();
  if (!h) return "web";
  if (restaurantDomain && (h === restaurantDomain || h.endsWith(`.${restaurantDomain}`))) return "restaurant";
  if (h.includes("tripadvisor")) return "tripadvisor";
  if (h.includes("yelp")) return "yelp";
  if (h.includes("zomato")) return "zomato";
  if (h.includes("thefork") || h.includes("eltenedor")) return "thefork";
  if (h.includes("foursquare")) return "foursquare";
  if (h.includes("wikimedia") || h.includes("wikipedia")) return "wikimedia";
  if (h.includes("openverse")) return "openverse";
  if (h.includes("facebook") || h.includes("instagram")) return "social";
  return "web";
}

export interface DishPhotoProvider {
  find(dish: string, restaurantHint?: string): Promise<DishPhoto[]>;
}

// Domeny, na których szukamy zdjęć dań (portale o restauracjach). Konfigurowalne
// przez DISH_PHOTO_DOMAINS (lista po przecinku); pusta = bez ograniczeń.
function dishPhotoDomains(): string[] {
  const def = "tripadvisor.com,yelp.com,zomato.com,thefork.com,foursquare.com";
  return (process.env.DISH_PHOTO_DOMAINS ?? def)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Buduje zapytanie „{danie} {lokal}" ograniczone do domen recenzenckich (site:). */
export function restaurantImageQuery(dish: string, hint?: string): string {
  const terms = [dish, hint].filter(Boolean).join(" ");
  const domains = dishPhotoDomains();
  if (domains.length === 0) return terms;
  return `${terms} (${domains.map((d) => `site:${d}`).join(" OR ")})`;
}

interface CseImageItem {
  link: string;
  displayLink?: string;
  image?: { contextLink?: string };
}
interface CseResponse {
  items?: CseImageItem[];
}

/** Provider trybu osobistego: Google Programmable Search Engine (obrazy). */
export class GoogleCseImageProvider implements DishPhotoProvider {
  constructor(
    private readonly key: string,
    private readonly cx: string,
    private readonly num = 5,
  ) {}

  async find(dish: string, restaurantHint?: string): Promise<DishPhoto[]> {
    // Doklejamy kontekst lokalu, by trafić w prawdziwe danie z tej restauracji.
    const query = [dish, restaurantHint].filter(Boolean).join(" ");
    const items = await this.search(query);
    // Fallback: jeśli z lokalem brak wyników, spróbuj samej nazwy dania.
    if (items.length === 0 && restaurantHint) return this.toPhotos(await this.search(dish));
    return this.toPhotos(items);
  }

  private async search(query: string): Promise<CseImageItem[]> {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", this.key);
    url.searchParams.set("cx", this.cx);
    url.searchParams.set("q", query);
    url.searchParams.set("searchType", "image");
    url.searchParams.set("num", String(this.num));
    url.searchParams.set("safe", "active");

    const res = await trackedFetch(url);
    if (!res.ok) {
      throw new Error(`Custom Search HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as CseResponse;
    return json.items ?? [];
  }

  private toPhotos(items: CseImageItem[]): DishPhoto[] {
    return items.map((it) => ({
      url: it.link,
      source: "google_cse",
      attribution: it.displayLink,
      contextUrl: it.image?.contextLink,
    }));
  }
}

// --- Provider zapasowy: Openverse (800 mln zdjęć CC / domena publiczna) ---
// Darmowy, bez klucza, LEGALNY (także do wydania w sklepie). Zdjęcia poglądowe.
interface OpenverseImage {
  title?: string;
  url?: string;
  thumbnail?: string;
  creator?: string;
  license?: string;
  foreign_landing_url?: string;
}
interface OpenverseResponse {
  results?: OpenverseImage[];
}

export class OpenverseProvider implements DishPhotoProvider {
  constructor(private readonly num = 5) {}

  async find(dish: string): Promise<DishPhoto[]> {
    const url = new URL("https://api.openverse.org/v1/images/");
    url.searchParams.set("q", dish);
    url.searchParams.set("page_size", String(this.num));

    const res = await trackedFetch(url, { headers: { "User-Agent": WIKI_UA } });
    if (!res.ok) throw new Error(`Openverse HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as OpenverseResponse;

    return (json.results ?? [])
      .map((r) => ({
        url: r.thumbnail ?? r.url ?? "",
        source: "openverse",
        attribution: [r.creator, r.license].filter(Boolean).join(" · ") || undefined,
        contextUrl: r.foreign_landing_url,
      }))
      .filter((p) => p.url);
  }
}

// --- Provider trybu osobistego: SerpApi (Google Images) ---
// Zapytanie „{danie} {restauracja} {miasto}" → realne zdjęcia z całego webu,
// często z tego konkretnego lokalu (blogi, recenzje, social). Cudze prace → tryb osobisty.
interface SerpImage {
  thumbnail?: string;
  original?: string;
  source?: string;
  title?: string;
  link?: string;
}
interface SerpResponse {
  images_results?: SerpImage[];
  error?: string;
}

export class SerpApiImageProvider implements DishPhotoProvider {
  constructor(
    private readonly key: string,
    private readonly num = 5,
  ) {}

  async find(dish: string, restaurantHint?: string): Promise<DishPhoto[]> {
    const query = restaurantImageQuery(dish, restaurantHint);
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_images");
    url.searchParams.set("q", query);
    url.searchParams.set("api_key", this.key);
    url.searchParams.set("safe", "active");

    const res = await trackedFetch(url);
    if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as SerpResponse;
    if (json.error) throw new Error(`SerpApi: ${json.error}`);

    return (json.images_results ?? [])
      .slice(0, this.num)
      .map((it) => ({
        url: it.thumbnail ?? it.original ?? "",
        source: "serpapi",
        attribution: it.source ?? it.title,
        contextUrl: it.link,
        // Domena ze strony źródłowej — inaczej photoSourceCategory zrzuca wszystko do „web"
        // (więc etykiety TripAdvisor/Yelp nie pojawiałyby się mimo trafień z tych portali).
        domain: hostOf(it.link),
      }))
      .filter((p) => p.url);
  }
}

// --- Provider poglądowy: Wikimedia Commons ---
// Darmowe, BEZ klucza, wysoki wolumen (do tła). Zdjęcia poglądowe typu dania.
interface WmPage {
  title?: string;
  imageinfo?: { thumburl?: string; descriptionurl?: string }[];
}
interface WmResponse {
  query?: { pages?: Record<string, WmPage> };
}

export class WikimediaProvider implements DishPhotoProvider {
  constructor(private readonly num = 3) {}

  async find(dish: string): Promise<DishPhoto[]> {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.searchParams.set("action", "query");
    url.searchParams.set("generator", "search");
    url.searchParams.set("gsrsearch", dish);
    url.searchParams.set("gsrnamespace", "6"); // pliki
    url.searchParams.set("gsrlimit", String(this.num));
    url.searchParams.set("prop", "imageinfo");
    url.searchParams.set("iiprop", "url");
    url.searchParams.set("iiurlwidth", "500");
    url.searchParams.set("format", "json");

    const res = await wikiFetch(url);
    if (!res.ok) throw new Error(`Wikimedia HTTP ${res.status}`);
    const j = (await res.json()) as WmResponse;
    const pages = j.query?.pages ? Object.values(j.query.pages) : [];
    return pages
      .map((p) => ({
        url: p.imageinfo?.[0]?.thumburl ?? "",
        source: "wikimedia",
        attribution: p.title,
        contextUrl: p.imageinfo?.[0]?.descriptionurl,
      }))
      .filter((p) => p.url);
  }
}

// --- Provider trybu osobistego: Serper.dev (Google Images) ---
// 2500 darmowych zapytań, potem ~$0.30–1/1000. Najlepszy stosunek darmowego do ceny.
interface SerperImage {
  title?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  source?: string;
  domain?: string;
  link?: string;
}
interface SerperResponse {
  images?: SerperImage[];
}

export class SerperImageProvider implements DishPhotoProvider {
  constructor(
    private readonly key: string,
    private readonly num = 5,
  ) {}

  async find(dish: string, restaurantHint?: string): Promise<DishPhoto[]> {
    const query = restaurantImageQuery(dish, restaurantHint);
    const res = await trackedFetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: this.num }),
    });
    if (!res.ok) throw new Error(`Serper HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as SerperResponse;
    return (json.images ?? [])
      .slice(0, this.num)
      .map((it) => ({
        url: it.thumbnailUrl ?? it.imageUrl ?? "",
        source: "serper",
        attribution: it.source ?? it.domain,
        contextUrl: it.link,
        domain: it.domain ?? hostOf(it.link),
      }))
      .filter((p) => p.url);
  }
}

/** Szukanie zdjęć dania na STRONIE LOKALU: `site:{domena} {danie}` (Serper). */
export async function restaurantSiteImages(dish: string, domain: string, num = 6): Promise<DishPhoto[]> {
  const key = process.env.SERPER_KEY;
  if (!key || !domain) return [];
  try {
    const res = await trackedFetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `${dish} site:${domain}`, num }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as SerperResponse;
    return (json.images ?? [])
      .slice(0, num)
      .map((it) => ({
        url: it.thumbnailUrl ?? it.imageUrl ?? "",
        source: "serper",
        attribution: it.source ?? it.domain,
        contextUrl: it.link,
        domain: it.domain ?? hostOf(it.link) ?? domain,
      }))
      .filter((p) => p.url);
  } catch {
    return [];
  }
}

/** Niskopoziomowe szukanie obrazów w Serper (Google Images). Pusta lista przy braku klucza/błędzie. */
async function serperImages(query: string, num: number, fallbackDomain?: string): Promise<DishPhoto[]> {
  const key = process.env.SERPER_KEY;
  if (!key) return [];
  try {
    const res = await trackedFetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as SerperResponse;
    return (json.images ?? [])
      .slice(0, num)
      .map((it) => ({
        url: it.thumbnailUrl ?? it.imageUrl ?? "",
        source: "serper",
        attribution: it.source ?? it.domain,
        contextUrl: it.link,
        domain: it.domain ?? hostOf(it.link) ?? fallbackDomain,
      }))
      .filter((p) => p.url);
  } catch {
    return [];
  }
}

/**
 * Zdjęcia dania ZAWĘŻONE do KONKRETNEGO lokalu na portalach recenzenckich:
 * „{nazwa} {restauracja} {miasto} (site:tripadvisor.com OR yelp.com OR …)". Miasto odsiewa
 * lokal o podobnej nazwie z innego miasta. `names` to warianty nazwy dania (np. nazwa z menu
 * + kanoniczna) — odpytujemy każdą, scalamy bez duplikatów URL.
 */
export async function venuePortalImages(
  names: string[],
  restaurant: string,
  city: string | undefined,
  numPerName = 6,
): Promise<DishPhoto[]> {
  if (!process.env.SERPER_KEY) return [];
  // Portale recenzenckie + media społecznościowe lokalu (FB/IG — realne zdjęcia wrzucane przez ludzi).
  const domains = [...dishPhotoDomains(), "facebook.com", "instagram.com"];
  const siteFilter = domains.length ? ` (${domains.map((d) => `site:${d}`).join(" OR ")})` : "";
  const venueQual = [restaurant, city].filter(Boolean).join(" ");
  const uniqNames = [...new Set(names.map((n) => n.trim()).filter(Boolean).map((n) => n.toLowerCase()))];
  // Filtr na portale: Google bywa, że IGNORUJE `site:` przy ubogich wynikach i zwraca blogi
  // kulinarne — tu zostawiamy TYLKO realne portale (reszta i tak trafi do Tier 2 „web").
  const onPortal = (im: DishPhoto) => {
    const h = (im.domain || hostOf(im.contextUrl) || "").toLowerCase();
    return domains.some((d) => h === d || h.endsWith(`.${d}`) || h.includes(d.replace(/\.[a-z]+$/, "")));
  };
  const out: DishPhoto[] = [];
  const seen = new Set<string>();
  for (const name of uniqNames) {
    const imgs = await serperImages(`${name} ${venueQual}${siteFilter}`, numPerName).catch(() => []);
    for (const im of imgs) if (im.url && onPortal(im) && !seen.has(im.url) && seen.add(im.url)) out.push(im);
  }
  return out;
}

/**
 * SZEROKIE wyszukiwanie zdjęć dania w całym webie — BEZ restauracji i BEZ ograniczenia
 * do domen. Łapie generyczne/markowe pozycje (woda, 7UP, naan, ryż), których mała knajpa
 * nie ma na portalach. Wyniki traktujemy jako „typ dania" (poglądowe) i tak samo weryfikujemy.
 */
export async function genericWebImages(dish: string, num = 6, cuisine?: string): Promise<DishPhoto[]> {
  const key = process.env.SERPER_KEY;
  if (!key) return [];
  // Doklejenie kuchni (np. „green salad indian") podnosi trafność kandydatów → wyższe
  // pokrycie po weryfikacji vision; dla nazw markowych (Coca-Cola) Google i tak to ignoruje.
  const q = [dish, cuisine?.trim()].filter(Boolean).join(" ");
  try {
    const res = await trackedFetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q, num }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as SerperResponse;
    return (json.images ?? [])
      .slice(0, num)
      .map((it) => ({
        url: it.thumbnailUrl ?? it.imageUrl ?? "",
        source: "serper",
        attribution: it.source ?? it.domain,
        contextUrl: it.link,
        domain: it.domain ?? hostOf(it.link),
      }))
      .filter((p) => p.url);
  } catch {
    return [];
  }
}

/**
 * Kontekstowe providery (prawdziwe zdjęcia „{danie} {restauracja}") w kolejności:
 * Serper (2500 free, najtaniej) → SerpApi (100/mies., zapas) → CSE (tylko stare konta).
 */
export function contextProviders(): DishPhotoProvider[] {
  const list: DishPhotoProvider[] = [];
  if (process.env.SERPER_KEY) list.push(new SerperImageProvider(process.env.SERPER_KEY));
  if (process.env.SERPAPI_KEY) list.push(new SerpApiImageProvider(process.env.SERPAPI_KEY));
  const cseKey = process.env.GOOGLE_CSE_KEY;
  const cseCx = process.env.GOOGLE_CSE_CX;
  if (cseKey && cseCx) list.push(new GoogleCseImageProvider(cseKey, cseCx));
  return list;
}

/** Pojedynczy provider (zgodność wsteczna): pierwszy kontekstowy lub Openverse. */
export function dishPhotoProviderFromEnv(): DishPhotoProvider {
  return contextProviders()[0] ?? new OpenverseProvider();
}
