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
import { runDishPhotos } from "./dishPhotosPipeline.ts";
import { quickPeek } from "./quickPeek.ts";
import { matchVenuePhotos, type VenueTaPhoto } from "./venuePhotos.ts";
import { snapshot, type Provider } from "./apiLog.ts";
import { ZERO_USAGE } from "./usage.ts";
import { initDb, logEvent, getStats, getRecentEvents, budgetExceeded, dailyBudgetUsd } from "./db.ts";
import { DEFAULT_MODEL, apiTag } from "./models.ts";

const app = new Hono();

// Trwałe logi (Postgres) — inicjalizacja na starcie; bez DATABASE_URL to no‑op.
void initDb();

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
  cuisineHint?: string;
  model?: string;
}

/** Normalizuje wejście (tablica lub pojedyncze) do InputImage[]. Rzuca przy błędzie. */
// Limit łącznego base64 zdjęć w jednym żądaniu (~25 MB zdekodowane ≈ 34M znaków base64) —
// zabezpieczenie przed przypadkowym ogromnym payloadem (pamięć/koszt). NIE ogranicza normalnego
// użycia (40 zdjęć po ~0.5 MB = ~27M znaków base64, mieści się).
const MAX_TOTAL_BASE64 = 36_000_000;

/** Komunikat o przekroczeniu dziennego budżetu (twardy hamulec). */
function budgetMsg(): string {
  return `Dzienny budżet ($${dailyBudgetUsd()}) przekroczony — AI wstrzymane do jutra. Zmień DAILY_BUDGET_USD na serwerze lub poczekaj.`;
}

function parseImages(body: ScanBody): InputImage[] {
  const raw: ImageInput[] = body.images?.length
    ? body.images
    : [{ imageBase64: body.imageBase64, mediaType: body.mediaType }];

  if (raw.length === 0) throw new Error("Brak zdjęć.");
  if (raw.length > MAX_IMAGES) throw new Error(`Maksymalnie ${MAX_IMAGES} zdjęć na skan.`);

  let totalB64 = 0;
  const out = raw.map((img, i) => {
    const b64 = img.base64 ?? img.imageBase64;
    if (!b64) throw new Error(`Zdjęcie ${i + 1}: brak base64.`);
    if (!img.mediaType || !ALLOWED_MEDIA.has(img.mediaType as MediaType)) {
      throw new Error(`Zdjęcie ${i + 1}: mediaType musi być image/jpeg, image/png lub image/webp.`);
    }
    // Akceptujemy też data-URL (data:image/...;base64,XXXX) — odcinamy nagłówek.
    const data = b64.includes(",") ? b64.split(",")[1]! : b64;
    totalB64 += data.length;
    return { base64: data, mediaType: img.mediaType as MediaType };
  });
  if (totalB64 > MAX_TOTAL_BASE64) {
    throw new Error("Zdjęcia są za duże (łącznie). Zmniejsz liczbę/rozmiar zdjęć i spróbuj ponownie.");
  }
  return out;
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

  if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);

  // Odpowiedź STRUMIENIOWA: w trakcie generowania (które przy wielu stronach trwa
  // >60 s) wysyłamy co kilka sekund spację — utrzymuje połączenie, żeby iOS nie
  // zerwał bezczynnego requestu (klasyczny „network error"). JSON.parse i tak
  // ignoruje wiodące białe znaki, więc finalny JSON parsuje się normalnie.
  return stream(c, async (s) => {
    const keepalive = setInterval(() => {
      s.write(" ").catch(() => {});
    }, 5000);
    try {
      const model = isModelId(body.model) ? body.model : DEFAULT_MODEL;
      const { menu, usage } = await extractMenu(images, {
        targetLang: body.targetLang?.trim() || "polski",
        restaurantHint: body.restaurantHint?.trim() || undefined,
        locationHint: body.locationHint?.trim() || undefined,
        cuisineHint: body.cuisineHint?.trim() || undefined,
        model,
      });
      // Trwały log skanu — do statystyk „ile menu / dań / koszt per model".
      const items = menu.sections.reduce((n, sec) => n + sec.items.length, 0);
      logEvent({
        type: "scan",
        op: "scan",
        model,
        provider: apiTag(model),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
        data: {
          images: images.length,
          sections: menu.sections.length,
          items,
          targetLang: body.targetLang?.trim() || "polski",
          locationHint: body.locationHint?.trim() || null,
          restaurant: menu.restaurant_name ?? null,
          cuisine: menu.cuisine ?? null,
        },
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
  if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);
  let body: DishInfoBody;
  try {
    body = await c.req.json<DishInfoBody>();
  } catch {
    return c.json({ error: "Nieprawidłowy JSON." }, 400);
  }
  if (!body.name?.trim()) return c.json({ error: "Brak nazwy dania." }, 400);

  try {
    const model = isModelId(body.model) ? body.model : DEFAULT_MODEL;
    const { text: info, usage } = await describeDish({
      name: body.name.trim(),
      description: body.description?.trim() || undefined,
      restaurant: body.restaurant?.trim() || undefined,
      cuisine: body.cuisine?.trim() || undefined,
      location: body.location?.trim() || undefined,
      targetLang: body.targetLang?.trim() || "polski",
      model,
    });
    logEvent({
      type: "ai",
      op: "dish-info",
      model,
      provider: apiTag(model),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      data: { dish: body.name.trim() },
    });
    return c.json({ info, usage });
  } catch (e) {
    console.error("dish-info error:", e);
    return c.json({ error: `Nie udało się pobrać informacji: ${(e as Error).message}` }, 502);
  }
});

// „Szybki podgląd" — lekka ocena 1 zdjęcia na żywo z aparatu (kuchnia / nazwa / czy to menu).
app.post("/quick-peek", async (c) => {
  if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);
  try {
    const body = (await c.req.json()) as { image?: { base64?: string; mediaType?: string }; model?: string };
    if (!body.image?.base64) return c.json({ error: "Brak zdjęcia." }, 400);
    const model = isModelId(body.model) ? body.model : DEFAULT_MODEL;
    const { result, usage } = await quickPeek(
      { base64: body.image.base64, mediaType: body.image.mediaType || "image/jpeg" },
      model,
    );
    logEvent({
      type: "ai",
      op: "quick-peek",
      model,
      provider: apiTag(model),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      data: { isMenu: result.isMenu, cuisine: result.cuisine },
    });
    return c.json({ ...result, usage });
  } catch (e) {
    return c.json({ error: `Podgląd nie powiódł się: ${(e as Error).message}` }, 502);
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
  photoQuery?: string; // kanoniczna nazwa dania do szukania OGÓLNEGO zdjęcia (lepsze trafienia)
  photoQueryLocal?: string; // nazwa dania w języku kraju — dodatkowy wariant do portali
  restaurantHint?: string;
  restaurantName?: string; // czysta nazwa lokalu — do zawężenia portali + POTWIERDZENIA źródła
  city?: string; // miasto lokalu — doklejane do zapytań portalowych
  taLocationId?: string; // location_id wpisu TripAdvisor — pewny werdykt „z lokalu" dla TA
  cuisine?: string; // kontekst kuchni — poprawia trafność weryfikacji
  website?: string; // strona lokalu (z Google Places) — dodatkowe źródło zdjęć
  num?: number;
  verify?: boolean; // weryfikacja vision (DOMYŚLNIE WŁĄCZONA; wyłącz przez verify:false)
  verifyModel?: string; // model weryfikacji zdjęć (Claude/GPT). Domyślnie Sonnet.
  representativeOnly?: boolean; // tylko poglądowe (Wikimedia, free, bez SerpApi/vision) — do tła
}

// Cała logika toru (tier 1/2/3 + weryfikacja + flaga fromVenue) jest w runDishPhotos
// (src/dishPhotosPipeline.ts) — TEN SAM kod używa LAB do symulacji na migawkach.
app.post("/dish-photos", async (c) => {
  if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);
  let body: DishPhotosBody;
  try {
    body = await c.req.json<DishPhotosBody>();
  } catch {
    return c.json({ error: "Nieprawidłowy JSON." }, 400);
  }
  if (!body.dish?.trim()) return c.json({ error: "Brak nazwy dania." }, 400);

  const verifyModel = body.verifyModel?.trim() || "claude-sonnet-4-6";
  try {
    const { photos, usage, debug } = await runDishPhotos({
      dish: body.dish.trim(),
      photoQuery: body.photoQuery,
      photoQueryLocal: body.photoQueryLocal,
      restaurantHint: body.restaurantHint,
      restaurantName: body.restaurantName,
      city: body.city,
      taLocationId: body.taLocationId,
      cuisine: body.cuisine,
      website: body.website,
      num: body.num,
      verify: body.verify,
      verifyModel,
      representativeOnly: body.representativeOnly,
    });
    logEvent({
      type: "ai",
      op: "dish-photos",
      model: verifyModel,
      provider: apiTag(verifyModel),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      data: { dish: body.dish.trim(), resultCount: photos.length, representativeOnly: !!body.representativeOnly },
    });
    return c.json({ photos, usage, debug });
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
    { provider: "google", label: "Google Gemini", paid: true, configured: !!process.env.GEMINI_API_KEY },
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

// Trwałe statystyki (Postgres) — agregaty przeżywające redeploy. enabled:false bez DB.
app.get("/stats", async (c) => {
  try {
    return c.json(await getStats());
  } catch (e) {
    return c.json({ enabled: false, error: (e as Error).message }, 200);
  }
});

// Ostatnie surowe zdarzenia z trwałego logu (do debug/eksportu). ?limit=200.
app.get("/events", async (c) => {
  try {
    const limit = Number(c.req.query("limit")) || 200;
    return c.json({ events: await getRecentEvents(limit) });
  } catch (e) {
    return c.json({ events: [], error: (e as Error).message }, 200);
  }
});

// Tier 0: pula zdjęć z lokalu (Google Places + TripAdvisor) → wizja → ★ dopasowania do dań.
app.post("/venue-photos", async (c) => {
  if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);
  try {
    const body = (await c.req.json()) as {
      photoNames?: string[];
      taPhotos?: VenueTaPhoto[];
      dishes?: string[];
      cuisine?: string;
      model?: string;
      certain?: boolean; // lokal pewny? (z /restaurant: nameVerified && !guessedByLocation)
    };
    const venueModel = body.model?.trim() || "claude-sonnet-4-6";
    const { matches, usage } = await matchVenuePhotos({
      photoNames: Array.isArray(body.photoNames) ? body.photoNames : [],
      taPhotos: Array.isArray(body.taPhotos) ? body.taPhotos : [],
      dishes: Array.isArray(body.dishes) ? body.dishes : [],
      cuisine: body.cuisine,
      model: venueModel,
      certain: body.certain !== false,
    });
    logEvent({
      type: "ai",
      op: "venue-photos",
      model: venueModel,
      provider: apiTag(venueModel),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      data: { dishes: Array.isArray(body.dishes) ? body.dishes.length : 0, matches: matches.length },
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
