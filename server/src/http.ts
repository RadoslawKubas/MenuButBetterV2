// HTTP backend: opakowuje logikę odczytu menu w endpoint dla aplikacji mobilnej.
// Lokalnie działa na Node (Hono + @hono/node-server); ten sam kod przenosi się
// później na serverless (Cloudflare Workers / Vercel) — patrz ARCHITECTURE.md.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import { extractMenu, isModelId, MODELS, type InputImage, type MediaType } from "./menu.ts";
import { describeDish } from "./dishInfo.ts";
import { findRestaurant, findRestaurantNearby, fetchPlacePhoto, type RestaurantInfo } from "./places.ts";
import { findTripAdvisor } from "./tripadvisor.ts";
import {
  contextProviders,
  genericWebImages,
  restaurantSiteImages,
  photoSourceCategory,
  OpenverseProvider,
  WikimediaProvider,
  type DishPhoto,
} from "./dishPhotos.ts";
import { scoreDishPhotos, MATCH_THRESHOLD } from "./verifyPhotos.ts";
import { matchVenuePhotos, type VenueTaPhoto } from "./venuePhotos.ts";
import { snapshot, type Provider } from "./apiLog.ts";
import { ZERO_USAGE, addUsage, type Usage } from "./usage.ts";

const app = new Hono();

// CORS — żeby appka (Expo web / urządzenie) mogła wołać endpoint w devie.
app.use("/*", cors());

// Token aplikacji: gdy ustawiony APP_TOKEN (produkcja w chmurze, gdzie endpoint jest
// publiczny), każdy request poza /health musi mieć nagłówek `x-app-token` = APP_TOKEN.
// Lokalnie (brak APP_TOKEN) przepuszczamy wszystko — żeby dev/LAN działał bez tokena.
// Uwaga: to „próg zwalniający" przeciw przypadkowemu nadużyciu, nie twarda ochrona
// (token zaszyty w apce da się odczytać) — ale odsiewa skanery i przypadkowy ruch.
const APP_TOKEN = process.env.APP_TOKEN;
if (APP_TOKEN) {
  app.use("/*", async (c, next) => {
    if (c.req.path === "/health") return next();
    // Nagłówek (zapytania JSON) ALBO ?t= (dla URL-i obrazków ładowanych w <Image>,
    // gdzie nie da się wygodnie dołożyć nagłówka).
    const token = c.req.header("x-app-token") ?? c.req.query("t");
    if (token !== APP_TOKEN) {
      return c.json({ error: "Brak autoryzacji." }, 401);
    }
    return next();
  });
}

app.get("/health", (c) => c.json({ ok: true, service: "menubutbetter" }));

// Lista dostępnych modeli — appka może ją pobrać, by zbudować selektor.
app.get("/models", (c) =>
  c.json({
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
  }),
);

const ALLOWED_MEDIA = new Set<MediaType>(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGES = 10;

interface ImageInput {
  base64?: string;
  imageBase64?: string;
  mediaType?: string;
}
interface ScanBody {
  images?: ImageInput[];
  // zgodność wstecz — pojedyncze zdjęcie:
  imageBase64?: string;
  mediaType?: string;
  targetLang?: string;
  restaurantHint?: string;
  locationHint?: string;
  model?: string;
}

/** Normalizuje wejście (tablica lub pojedyncze) do InputImage[]. Rzuca przy błędzie. */
function parseImages(body: ScanBody): InputImage[] {
  const raw: ImageInput[] = body.images?.length
    ? body.images
    : [{ imageBase64: body.imageBase64, mediaType: body.mediaType }];

  if (raw.length === 0) throw new Error("Brak zdjęć.");
  if (raw.length > MAX_IMAGES) throw new Error(`Maksymalnie ${MAX_IMAGES} zdjęć na skan.`);

  return raw.map((img, i) => {
    const b64 = img.base64 ?? img.imageBase64;
    if (!b64) throw new Error(`Zdjęcie ${i + 1}: brak base64.`);
    if (!img.mediaType || !ALLOWED_MEDIA.has(img.mediaType as MediaType)) {
      throw new Error(`Zdjęcie ${i + 1}: mediaType musi być image/jpeg, image/png lub image/webp.`);
    }
    // Akceptujemy też data-URL (data:image/...;base64,XXXX) — odcinamy nagłówek.
    const data = b64.includes(",") ? b64.split(",")[1]! : b64;
    return { base64: data, mediaType: img.mediaType as MediaType };
  });
}

app.post("/scan", async (c) => {
  let body: ScanBody;
  try {
    body = await c.req.json<ScanBody>();
  } catch {
    return c.json({ error: "Nieprawidłowy JSON w treści żądania." }, 400);
  }

  let images: InputImage[];
  try {
    images = parseImages(body);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }

  // Odpowiedź STRUMIENIOWA: w trakcie generowania (które przy wielu stronach trwa
  // >60 s) wysyłamy co kilka sekund spację — utrzymuje połączenie, żeby iOS nie
  // zerwał bezczynnego requestu (klasyczny „network error"). JSON.parse i tak
  // ignoruje wiodące białe znaki, więc finalny JSON parsuje się normalnie.
  return stream(c, async (s) => {
    const keepalive = setInterval(() => {
      s.write(" ").catch(() => {});
    }, 5000);
    try {
      const { menu, usage } = await extractMenu(images, {
        targetLang: body.targetLang?.trim() || "polski",
        restaurantHint: body.restaurantHint?.trim() || undefined,
        locationHint: body.locationHint?.trim() || undefined,
        model: isModelId(body.model) ? body.model : undefined,
      });
      await s.write(JSON.stringify({ menu, usage }));
    } catch (e) {
      console.error("scan error:", e);
      await s.write(JSON.stringify({ error: `Odczyt menu nie powiódł się: ${(e as Error).message}` }));
    } finally {
      clearInterval(keepalive);
    }
  });
});

interface DishInfoBody {
  name?: string;
  description?: string;
  restaurant?: string;
  cuisine?: string;
  location?: string;
  targetLang?: string;
  model?: string;
}

app.post("/dish-info", async (c) => {
  let body: DishInfoBody;
  try {
    body = await c.req.json<DishInfoBody>();
  } catch {
    return c.json({ error: "Nieprawidłowy JSON." }, 400);
  }
  if (!body.name?.trim()) return c.json({ error: "Brak nazwy dania." }, 400);

  try {
    const { text: info, usage } = await describeDish({
      name: body.name.trim(),
      description: body.description?.trim() || undefined,
      restaurant: body.restaurant?.trim() || undefined,
      cuisine: body.cuisine?.trim() || undefined,
      location: body.location?.trim() || undefined,
      targetLang: body.targetLang?.trim() || "polski",
      model: isModelId(body.model) ? body.model : undefined,
    });
    return c.json({ info, usage });
  } catch (e) {
    console.error("dish-info error:", e);
    return c.json({ error: `Nie udało się pobrać informacji: ${(e as Error).message}` }, 502);
  }
});

interface RestaurantBody {
  name?: string;
  address?: string;
  cuisine?: string; // do fallbacku po GPS, gdy brak nazwy
  lat?: number;
  lng?: number;
  lang?: string;
  radius?: number; // zasięg „w pobliżu" w metrach (klient może zwiększać)
}

app.post("/restaurant", async (c) => {
  if (!process.env.GOOGLE_MAPS_KEY) {
    return c.json({ error: "Brak GOOGLE_MAPS_KEY na serwerze." }, 503);
  }
  let body: RestaurantBody;
  try {
    body = await c.req.json<RestaurantBody>();
  } catch {
    return c.json({ error: "Nieprawidłowy JSON." }, 400);
  }

  const name = body.name?.trim() || undefined;
  const lat = typeof body.lat === "number" ? body.lat : undefined;
  const lng = typeof body.lng === "number" ? body.lng : undefined;
  const lang = body.lang?.trim() || undefined;
  // Potrzebujemy nazwy ALBO współrzędnych — inaczej nie ma jak szukać.
  if (!name && (lat == null || lng == null)) {
    return c.json({ error: "Brak nazwy lokalu i lokalizacji." }, 400);
  }

  // Doczepia ocenę/link z TripAdvisora (po nazwie). Ciche niepowodzenie.
  async function withTripAdvisor(r: RestaurantInfo): Promise<RestaurantInfo> {
    r.tripAdvisor = await findTripAdvisor({
      name: r.name,
      lat: r.location?.lat,
      lng: r.location?.lng,
      lang,
    }).catch((e) => {
      console.error("tripadvisor error:", e);
      return null;
    });
    return r;
  }

  try {
    // 1) Mamy nazwę → standardowe wyszukiwanie po nazwie + okolicy.
    if (name) {
      const restaurant = await findRestaurant({ name, address: body.address?.trim() || undefined, lat, lng, lang });
      if (restaurant) {
        await withTripAdvisor(restaurant);
        return c.json({ restaurant, candidates: [] });
      }
    }

    // 2) Brak nazwy LUB nic nie znaleziono → fallback po GPS + kuchni.
    if (lat != null && lng != null) {
      const radius = typeof body.radius === "number" ? body.radius : undefined;
      const candidates = await findRestaurantNearby({ lat, lng, cuisine: body.cuisine?.trim() || undefined, lang, radius });
      if (candidates.length > 0) {
        const best = await withTripAdvisor(candidates[0]!);
        // best zgadnięty, reszta jako alternatywy do wyboru w apce
        return c.json({ restaurant: best, candidates });
      }
    }

    return c.json({ restaurant: null, candidates: [] });
  } catch (e) {
    console.error("restaurant error:", e);
    return c.json({ error: `Wyszukiwanie lokalu nie powiodło się: ${(e as Error).message}` }, 502);
  }
});

interface DishPhotosBody {
  dish?: string;
  photoQuery?: string; // generyczna nazwa dania (EN) do szukania OGÓLNEGO zdjęcia (lepsze trafienia)
  restaurantHint?: string;
  restaurantName?: string; // czysta nazwa lokalu — do POTWIERDZENIA, że zdjęcie jest z jego strony
  cuisine?: string; // kontekst kuchni — poprawia trafność weryfikacji
  website?: string; // strona lokalu (z Google Places) — dodatkowe źródło zdjęć
  num?: number;
  verify?: boolean; // weryfikacja vision (DOMYŚLNIE WŁĄCZONA; wyłącz przez verify:false)
  representativeOnly?: boolean; // tylko poglądowe (Wikimedia, free, bez SerpApi/vision) — do tła
}

// Tylko litery/cyfry, bez diakrytyków — do porównań nazwa↔URL.
function stripAlnum(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

app.post("/dish-photos", async (c) => {
  let body: DishPhotosBody;
  try {
    body = await c.req.json<DishPhotosBody>();
  } catch {
    return c.json({ error: "Nieprawidłowy JSON." }, 400);
  }
  if (!body.dish?.trim()) return c.json({ error: "Brak nazwy dania." }, 400);

  const dish = body.dish.trim();
  // Termin do OGÓLNEGO szukania (typ dania) — generyczny `photo_query` z menu, jeśli jest.
  // Lokalna/markowa nazwa „Nordic Taste" trafia gorzej niż „smoked salmon avocado toast".
  const genericTerm = body.photoQuery?.trim() || dish;
  const hint = body.restaurantHint?.trim() || undefined;
  const cuisine = body.cuisine?.trim() || undefined;
  const num = body.num ?? 4;
  // Domena strony lokalu (jeśli znana) — do osobnego wyszukiwania i kategorii „restaurant".
  let restaurantDomain: string | undefined;
  if (body.website?.trim()) {
    try {
      restaurantDomain = new URL(body.website.trim()).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      /* nieprawidłowy URL — pomijamy */
    }
  }
  // Klucz nazwy lokalu (np. „curcuma") do potwierdzenia, że strona portalu jest TEGO lokalu.
  const venueKey = body.restaurantName?.trim() ? stripAlnum(body.restaurantName) : "";

  // Log debugowy ścieżki szukania zdjęć (zwracany w odpowiedzi → przycisk 🐛 przy daniu).
  // `candidates` = co KONKRETNIE zwróciło API (URL + domena + strona źródłowa) oraz ocena
  // weryfikacji vision per zdjęcie — żeby dało się analizować, czemu coś przeszło/odpadło.
  type DbgCandidate = { url: string; domain?: string; context?: string; score?: number; passed?: boolean };
  type DbgStep = {
    tier: string;
    provider: string;
    query: string;
    returned: number;
    passed?: number;
    candidates?: DbgCandidate[];
  };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const candListOf = (list: DishPhoto[]): DbgCandidate[] =>
    list.map((p) => ({ url: p.url, domain: p.domain, context: p.contextUrl }));
  const candScoredOf = (list: (DishPhoto & { score: number })[]): DbgCandidate[] =>
    list.map((p) => ({ url: p.url, domain: p.domain, context: p.contextUrl, score: r2(p.score), passed: p.score >= MATCH_THRESHOLD }));
  const dbg: { params: Record<string, unknown>; steps: DbgStep[]; resultCount: number } = {
    params: {
      dish,
      photoQuery: body.photoQuery?.trim() || null,
      genericTerm,
      restaurantName: body.restaurantName || null,
      restaurantDomain: restaurantDomain || null,
      cuisine: cuisine || null,
      num,
      verify: body.verify !== false,
      representativeOnly: !!body.representativeOnly,
    },
    steps: [],
    resultCount: 0,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const respond = (photos: any[], usage: Usage) => {
    dbg.resultCount = photos.length;
    return c.json({ photos, usage, debug: dbg });
  };

  // Zdjęcia POGLĄDOWE (typ dania): Serper (Google Images) → Wikimedia → Openverse fallback.
  // Serper ma dużo wyższe pokrycie trafnych zdjęć dań niż Commons (zmierzone: 93% vs 60%);
  // Commons często zwraca mapy/budynki/przypadkowe pliki, więc był słabym źródłem startowym.
  // DOMYŚLNIE WERYFIKOWANE wizją; jak nic nie pokazuje dania → PUSTA lista (lepiej brak niż bzdura).
  async function representatives(verify: boolean): Promise<{
    photos: { url: string; source: string; attribution?: string; verified: boolean; representative: boolean }[];
    usage: Usage;
  }> {
    const pool = Math.max(num * 2, 6);
    let provider = "Serper (web)";
    let found = await genericWebImages(genericTerm, pool).catch(() => []);
    if (found.length === 0) {
      provider = "Wikimedia";
      found = await new WikimediaProvider(pool).find(genericTerm).catch(() => []);
    }
    if (found.length === 0) {
      provider = "Openverse";
      found = await new OpenverseProvider(pool).find(genericTerm).catch(() => []);
    }
    const step: DbgStep = { tier: "Poglądowe (typ dania)", provider, query: genericTerm, returned: found.length };
    dbg.steps.push(step);
    if (found.length === 0) return { photos: [], usage: ZERO_USAGE };
    // Etykieta źródła: dla wyników z domeną (Serper) → kategoria (web/tripadvisor…),
    // dla Wikimedia/Openverse (bez domeny) → ich własny source.
    const srcOf = (p: DishPhoto) => (p.domain ? photoSourceCategory(p.domain) : p.source);
    if (!verify) {
      step.passed = Math.min(found.length, num);
      step.candidates = candListOf(found);
      return {
        photos: found.slice(0, num).map((p) => ({
          url: p.url, source: srcOf(p), attribution: p.attribution, verified: false, representative: true,
        })),
        usage: ZERO_USAGE,
      };
    }
    const { scores, usage } = await scoreDishPhotos(genericTerm, found.map((p) => p.url), { cuisine });
    const scored = found.map((p, i) => ({ ...p, score: scores[i] ?? 0 }));
    step.candidates = candScoredOf(scored);
    const filtered = scored
      .filter((p) => p.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    step.passed = filtered.length;
    const photos = filtered
      .slice(0, num)
      .map((p) => ({ url: p.url, source: srcOf(p), attribution: p.attribution, verified: false, representative: true }));
    return { photos, usage };
  }

  // Tryb poglądowy (do tła po skanie): Wikimedia/Openverse, też weryfikowane (chyba że verify:false).
  if (body.representativeOnly) {
    try {
      const { photos, usage } = await representatives(body.verify !== false);
      return respond(photos, usage);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  }

  try {
    let total: Usage = ZERO_USAGE;
    const verify = body.verify !== false;

    // Weryfikuje listę i zwraca te, które pokazują danie (≥ próg), posortowane po trafności.
    // `term` = po czym weryfikować (oryginał dla „z lokalu", generyczny dla web).
    async function keepMatching(list: DishPhoto[], term: string = dish) {
      const { scores, usage } = await scoreDishPhotos(term, list.map((p) => p.url), { cuisine });
      total = addUsage(total, usage);
      const scored = list.map((p, i) => ({ ...p, score: scores[i] ?? 0 }));
      const passing = scored.filter((p) => p.score >= MATCH_THRESHOLD).sort((a, b) => b.score - a.score);
      return { passing, scored };
    }
    const cat = (p: DishPhoto) => photoSourceCategory(p.domain, restaurantDomain);
    // POTWIERDZONE „z tego lokalu": własna domena LUB nazwa lokalu w URL strony portalu.
    const fromVenue = (p: DishPhoto) =>
      cat(p) === "restaurant" ||
      (venueKey.length >= 4 && stripAlnum(p.contextUrl ?? "").includes(venueKey));

    // TIER 1: „z lokalu" — OSOBNO strona lokalu (site:domena) + OSOBNO portale recenzenckie, scalone.
    const tier1: DishPhoto[] = [];
    if (restaurantDomain) {
      const site = await restaurantSiteImages(dish, restaurantDomain, 6).catch(() => []);
      dbg.steps.push({ tier: "Tier1 strona lokalu", provider: `site:${restaurantDomain}`, query: dish, returned: site.length, candidates: candListOf(site) });
      tier1.push(...site);
    }
    for (const p of contextProviders()) {
      const portal = await p.find(dish, hint).catch(() => []);
      dbg.steps.push({ tier: "Tier1 portale", provider: p.constructor.name, query: dish, returned: portal.length, candidates: candListOf(portal) });
      if (portal.length > 0) {
        tier1.push(...portal);
        break;
      }
    }
    const seen = new Set<string>();
    const ctx = tier1.filter((p) => p.url && !seen.has(p.url) && seen.add(p.url));

    if (!verify && ctx.length > 0) {
      const photos = ctx.slice(0, num).map((p) => ({
        url: p.url, source: cat(p), attribution: p.attribution, verified: false, representative: false, fromVenue: fromVenue(p),
      }));
      return respond(photos, ZERO_USAGE);
    }
    if (verify && ctx.length > 0) {
      const { passing, scored } = await keepMatching(ctx);
      dbg.steps.push({ tier: "Tier1 weryfikacja vision", provider: "Sonnet", query: dish, returned: ctx.length, passed: passing.length, candidates: candScoredOf(scored) });
      if (passing.length > 0) {
        const photos = passing
          // Potwierdzone „z tego lokalu" najpierw, potem reszta (w grupie — po trafności).
          .sort((a, b) => (fromVenue(a) ? 0 : 1) - (fromVenue(b) ? 0 : 1) || b.score - a.score)
          .slice(0, num)
          .map((p) => ({
            url: p.url, source: cat(p), attribution: p.attribution, verified: true, representative: false, fromVenue: fromVenue(p),
          }));
        return respond(photos, total);
      }
    }

    // TIER 2: SZEROKO z sieci (bez restauracji) — realne zdjęcia tego dania/produktu jako „typ dania".
    if (verify) {
      const generic = await genericWebImages(genericTerm, 6);
      if (generic.length > 0) {
        const { passing, scored } = await keepMatching(generic, genericTerm);
        dbg.steps.push({ tier: "Tier2 web (typ dania)", provider: "Serper", query: genericTerm, returned: generic.length, passed: passing.length, candidates: candScoredOf(scored) });
        if (passing.length > 0) {
          const photos = passing.slice(0, num).map((p) => ({
            url: p.url, source: cat(p), attribution: p.attribution, verified: false, representative: true,
          }));
          return respond(photos, total);
        }
      } else {
        dbg.steps.push({ tier: "Tier2 web (typ dania)", provider: "Serper", query: genericTerm, returned: 0, passed: 0 });
      }
    }

    // TIER 3: poglądowe (Serper→Wikimedia→Openverse) — ostatnia deska.
    const rep = await representatives(verify);
    return respond(rep.photos, addUsage(total, rep.usage));
  } catch (e) {
    console.error("dish-photos error:", e);
    return c.json({ error: `Wyszukiwanie zdjęć nie powiodło się: ${(e as Error).message}` }, 502);
  }
});

// Diagnostyka: lista zewnętrznych API których bezpośrednio używamy + liczby zapytań i logi.
app.get("/diagnostics", (c) => {
  const reps = new Map(snapshot().map((r) => [r.provider, r]));
  const KNOWN: { provider: Provider; label: string; paid: boolean; configured: boolean }[] = [
    { provider: "claude", label: "Claude (Anthropic)", paid: true, configured: !!process.env.ANTHROPIC_API_KEY },
    { provider: "openai", label: "OpenAI (GPT)", paid: true, configured: !!process.env.OPENAI_API_KEY },
    { provider: "google_places", label: "Google Places", paid: true, configured: !!process.env.GOOGLE_MAPS_KEY },
    { provider: "tripadvisor", label: "TripAdvisor", paid: false, configured: !!process.env.TRIPADVISOR_KEY },
    { provider: "serper", label: "Serper.dev", paid: true, configured: !!process.env.SERPER_KEY },
    { provider: "serpapi", label: "SerpApi", paid: true, configured: !!process.env.SERPAPI_KEY },
    { provider: "wikimedia", label: "Wikimedia Commons", paid: false, configured: true },
    { provider: "openverse", label: "Openverse", paid: false, configured: true },
    {
      provider: "google_cse",
      label: "Google CSE",
      paid: true,
      configured: !!(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX),
    },
  ];
  const providers = KNOWN.map((k) => {
    const r = reps.get(k.provider);
    return {
      ...k,
      total: r?.total ?? 0,
      ok: r?.ok ?? 0,
      errors: r?.errors ?? 0,
      lastAt: r?.lastAt ?? null,
      lastError: r?.lastError ?? null,
      inputTokens: r?.inputTokens ?? 0,
      outputTokens: r?.outputTokens ?? 0,
      costUsd: r?.costUsd ?? 0,
      entries: r?.entries ?? [],
    };
  });
  const other = reps.get("other");
  if (other && other.total > 0) {
    providers.push({ label: "Inne", paid: false, configured: true, ...other });
  }
  return c.json({ now: Date.now(), providers });
});

// Tier 0: pula zdjęć z lokalu (Google Places + TripAdvisor) → wizja → ★ dopasowania do dań.
app.post("/venue-photos", async (c) => {
  try {
    const body = (await c.req.json()) as {
      photoNames?: string[];
      taPhotos?: VenueTaPhoto[];
      dishes?: string[];
      cuisine?: string;
    };
    const { matches, usage } = await matchVenuePhotos({
      photoNames: Array.isArray(body.photoNames) ? body.photoNames : [],
      taPhotos: Array.isArray(body.taPhotos) ? body.taPhotos : [],
      dishes: Array.isArray(body.dishes) ? body.dishes : [],
      cuisine: body.cuisine,
    });
    return c.json({ matches, usage });
  } catch (e) {
    console.error("venue-photos error:", e);
    return c.json({ error: (e as Error).message, matches: [], usage: ZERO_USAGE }, 500);
  }
});

// Proxy zdjęcia lokalu — klucz Google zostaje po stronie serwera.
app.get("/place-photo", async (c) => {
  const name = c.req.query("name");
  const w = Number(c.req.query("w")) || 800;
  if (!name) return c.json({ error: "Brak parametru name." }, 400);
  try {
    const { body, contentType } = await fetchPlacePhoto(name, w);
    return c.body(body, 200, { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" });
  } catch (e) {
    console.error("place-photo error:", e);
    return c.json({ error: (e as Error).message }, 502);
  }
});

const port = Number(process.env.PORT) || 8787;
// hostname 0.0.0.0 — żeby telefon w tej samej sieci Wi-Fi dosięgnął serwera po LAN.
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`🍝 MenuButBetter API na http://localhost:${info.port} (LAN: 0.0.0.0:${info.port})`);
  console.log(`   GET  /health`);
  console.log(`   POST /scan   { imageBase64, mediaType, targetLang?, restaurantHint? }`);
});
