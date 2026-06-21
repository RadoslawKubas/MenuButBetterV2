// HTTP backend: opakowuje logikę odczytu menu w endpoint dla aplikacji mobilnej.
// Lokalnie działa na Node (Hono + @hono/node-server); ten sam kod przenosi się
// później na serverless (Cloudflare Workers / Vercel) — patrz ARCHITECTURE.md.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";
import { extractMenu, enrichMenu, menuToStructure, isModelId, MODELS, type InputImage, type MediaType } from "./menu.ts";
import type { Menu, MenuSection } from "./schema.ts";
import { describeDish } from "./dishInfo.ts";
import { findRestaurant, findRestaurantNearby, fetchPlacePhoto, type RestaurantInfo } from "./places.ts";
import { findTripAdvisor } from "./tripadvisor.ts";
import { runDishPhotos, reprPhotoCacheKey } from "./dishPhotosPipeline.ts";
import { quickPeek } from "./quickPeek.ts";
import { matchVenuePhotos, type VenueTaPhoto } from "./venuePhotos.ts";
import { snapshot, recordBytes, cacheHitsSnapshot, type Provider } from "./apiLog.ts";
import { ZERO_USAGE } from "./usage.ts";
import { initDb, closeDb, logEvent, getStats, getRecentEvents, getClientErrors, getInstallActivity, upsertInstall, setInstallName, getInstalls, reqContext, budgetExceeded, dailyBudgetUsd, getSessionCost, readPriceOverrides, savePriceOverrides } from "./db.ts";
// ⚠️ Jednorazowe naprawy danych (NIE rdzeń — patrz dataFixes.ts). Do usunięcia po wdrożeniu nowej apki.
import { backfillAppSource, attributeOrphansByTime, backfillSyntheticSessions } from "./dataFixes.ts";
import { getSessions, getSessionEvents, getSourceCounts } from "./sessions.ts";
import { apiCallCost, getPriceOverrides, otherRate, type PriceOverrides } from "./pricing.ts";
import { initCache, cacheDelete, cacheStats, cacheBrowse, cacheSize, cacheGet, cacheSet, cacheKey } from "./cache.ts";
import { createHash, randomUUID } from "node:crypto";
import { initSamples, samplesEnabled, storeMode, saveSample, listSamples, getSampleZip, markImported, deleteSample, statusByHashes } from "./samples.ts";
import { DEFAULT_MODEL, apiTag, type ModelId } from "./models.ts";

const app = new Hono();

// Trwałe logi (Postgres) — inicjalizacja na starcie; bez DATABASE_URL to no‑op.
void initDb();
// Cache treści (Postgres + LRU) — obniża koszt powtórek; bez DATABASE_URL działa tylko L1.
void initCache();
// Sample online (Postgres) — apka wysyła migawki, lab je importuje; bez DATABASE_URL wyłączone.
void initSamples();

// CORS — żeby appka (Expo web / urządzenie) mogła wołać endpoint w devie.
app.use("/*", cors({ origin: "*", exposeHeaders: ["x-session-cost"] })); // expose: apka musi móc odczytać live koszt sesji

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

// Kontekst instalacji: z nagłówka x-install-id (GUID apki) — wszystkie logEvent w tym requeście
// (skan, ai, błąd, sample) zostaną otagowane tym GUID-em → grupowanie per instancja w labie.
app.use("/*", async (c, next) => {
  // Tożsamość apki: z nagłówka X-* (zwykłe fetch/XHR) ALBO z query ?iid=/?sid= — bo żądania ŁADOWANE URL-em
  // (<Image>, pobieranie pliku, np. /place-photo) NIE mogą wysyłać nagłówków. To ten sam kanał, którym apka
  // wozi token (?t=) — STAŁY element rdzenia, nie naprawa. Dzięki temu każde żądanie identyfikuje instancję.
  const installId = c.req.header("x-install-id") || c.req.query("iid") || undefined;
  // Debug apki: x-force-fresh=1 → cache POMIJA ODCZYT (świeże generowanie), ale nadal ZAPISUJE wynik.
  const forceFresh = c.req.header("x-force-fresh") === "1";
  // Sesja usera (x-session-id): od „nowy skan" do „nowy skan" — wspólny tag wszystkich ops jednego skanu.
  const sessionId = c.req.header("x-session-id") || c.req.query("sid") || undefined;
  // „app" tylko gdy nagłówek x-client:app (ustawia go DETERMINISTYCZNIE prawdziwa apka). Brak → eksperyment.
  const source = c.req.header("x-client") === "app" ? "app" : undefined;
  const apiUsage = new Map<string, { calls: number; inTok: number; outTok: number; costUsd: number; bytesSent: number; bytesRecv: number }>();
  await reqContext.run({ installId, forceFresh, sessionId, source, apiUsage }, async () => {
    await next();
    // Po obsłudze: zdarzenia dla nie-AI providerów (wyszukiwanie zdjęć/lokalu) — żeby ich koszt NIE umykał
    // i był ODDZIELONY od weryfikacji (AI). Serper = wyszukiwanie zdjęć; Places = lokal; itd. sessionId z ctx.
    const NON_AI = new Set(["serper", "serpapi", "google_cse", "google_places", "google_places_photo", "tripadvisor", "wikimedia", "openverse"]);
    for (const [prov, u] of apiUsage) {
      if (!NON_AI.has(prov) || u.calls <= 0) continue;
      // Koszt nie-AI wg WSPÓLNEGO cennika (pricing.ts + override'y z labu) → akumulator sesji liczy KAŻDY
      // koszt. Lab przelicza nie-AI z data.calls tą samą metodą (costUsd zdarzenia api ignoruje) — brak dubla.
      const costUsd = apiCallCost(prov, u.calls, getPriceOverrides());
      logEvent({ type: "api", op: prov, provider: prov as Provider, costUsd, data: { calls: u.calls, bytesSent: u.bytesSent } });
    }
    // Aktualny sumaryczny koszt sesji → nagłówek dla apki (live „ile sesja kosztuje"). Dla zwykłych
    // odpowiedzi JSON działa; dla strumieniowych nagłówek jest już wysłany — tam koszt dojdzie z kolejnym requestem.
    if (sessionId) { try { c.res.headers.set("x-session-cost", getSessionCost(sessionId).toFixed(6)); } catch { /* nagłówki już wysłane */ } }
  });
});

// Ruch apka ↔ serwer: odebrane = upload od apki (Content-Length żądania, głównie zdjęcia),
// wysłane = odpowiedź do apki (Content-Length, gdy nie strumień). Egress liczy się na Railway.
app.use("/*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const reqLen = Number(c.req.header("content-length")) || 0;
  await next();
  const resLen = Number(c.res.headers.get("content-length")) || 0;
  recordBytes("app", resLen, reqLen);
});

app.get("/health", (c) => c.json({ ok: true, service: "menubutbetter" }));

// Lista dostępnych modeli — appka może ją pobrać, by zbudować selektor.
app.get("/models", (c) =>
  c.json({
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
  }),
);

const ALLOWED_MEDIA = new Set<MediaType>(["image/jpeg", "image/png", "image/webp"]);
// Backstop liczby zdjęć/żądanie (hojny — apka i tak self-limituje po ROZMIARZE; tu tylko sanity).
// Realny limit to MAX_TOTAL_BASE64 (rozmiar) — zgodnie z „pakuj ile się zmieści", nie sztywna liczba.
const MAX_IMAGES = 20;

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
  /** Model przebiegu WZBOGACANIA (tekst). Używany przy skanie dwuprzebiegowym; gdy brak = model. */
  enrichModel?: string;
  /** Apka prosi o KROKI postępu (NDJSON: received → extracting… → done/error).
   *  Bez tego — stare zachowanie (spacje keepalive + finalny JSON), zgodne ze starym buildem. */
  stream?: boolean;
  /** TYLKO struktura (Faza A apki) — bez enrichu; enrich osobno przez /enrich. */
  structureOnly?: boolean;
  /** Sekcje z wcześniejszych partii (ciągłość grup między stronami przy menu dzielonym na partie). */
  knownSections?: string[];
  /** Lokale „w pobliżu" (Nearby Search z apki, mały promień) — nazwa + kuchnia. Vision wskaże, do
   *  którego pasuje menu (venue_match), zwracane w kroku „meta". */
  nearbyVenues?: { name?: string; cuisine?: string | null }[];
}

/** Normalizuje wejście (tablica lub pojedyncze) do InputImage[]. Rzuca przy błędzie. */
// Limit łącznego base64 zdjęć w jednym żądaniu (~25 MB zdekodowane ≈ 34M znaków base64) —
// zabezpieczenie przed przypadkowym ogromnym payloadem (pamięć/koszt). NIE ogranicza normalnego
// użycia (40 zdjęć po ~0.5 MB = ~27M znaków base64, mieści się).
const MAX_TOTAL_BASE64 = 36_000_000;

/** Hash pojedynczego zdjęcia (z base64) — klucz rejestru „złych kadrów" + identyfikacja dla apki. */
function photoHash(base64: string): string {
  return createHash("sha256").update(base64).digest("hex").slice(0, 32);
}

/** Sanityzacja listy „w pobliżu" z apki → {name, cuisine}. Cap 12 (krótka lista do promptu). */
function sanitizeNearby(v: { name?: string; cuisine?: string | null }[] | undefined): { name: string; cuisine?: string | null }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x) => x && typeof x.name === "string" && x.name.trim().length > 0)
    .slice(0, 12)
    .map((x) => ({ name: x.name!.trim(), cuisine: typeof x.cuisine === "string" && x.cuisine.trim() ? x.cuisine.trim() : null }));
  return out.length ? out : undefined;
}

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

  // Backstop „złych kadrów": odrzuć zdjęcia, które peek wcześniej uznał za za słabej jakości
  // (apka i tak ich nie wysyła — to obrona przed marnowaniem drogiego skanu). Wszystkie złe → błąd.
  try {
    const checked = await Promise.all(images.map(async (img) => ({
      img,
      bad: !!(await cacheGet("bad-photo", cacheKey("bad-photo", photoHash(img.base64)), { op: "scan" })),
    })));
    const kept = checked.filter((x) => !x.bad).map((x) => x.img);
    if (kept.length === 0) {
      return c.json({ error: "Wszystkie zdjęcia odrzucone — za słaba jakość, nie da się nic odczytać. Zrób ostrzejsze/jaśniejsze zdjęcie." }, 422);
    }
    images = kept;
  } catch { /* rejestr niedostępny → skanuj normalnie */ }

  if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);

  // Odpowiedź STRUMIENIOWA: w trakcie generowania (które przy wielu stronach trwa
  // >60 s) wysyłamy co kilka sekund spację — utrzymuje połączenie, żeby iOS nie
  // zerwał bezczynnego requestu (klasyczny „network error"). JSON.parse i tak
  // ignoruje wiodące białe znaki, więc finalny JSON parsuje się normalnie.
  // Z `stream:true` (nowa apka) wysyłamy KROKI NDJSON („received" → cykliczne „extracting"
  // z czasem → „done"/„error"). Bez tego — stare zachowanie: spacje keepalive + finalny JSON.
  const wantSteps = body.stream === true;
  const t0 = Date.now();
  return stream(c, async (s) => {
    if (wantSteps) await s.write(JSON.stringify({ phase: "received", images: images.length }) + "\n");
    let latestItems = 0; // ile pozycji model już wypisał (z onProgress) — dokładane do każdego kroku
    const keepalive = setInterval(() => {
      const beat = wantSteps ? JSON.stringify({ phase: "extracting", elapsedMs: Date.now() - t0, items: latestItems }) + "\n" : " ";
      s.write(beat).catch(() => {});
    }, wantSteps ? 2000 : 5000);
    try {
      const model = isModelId(body.model) ? body.model : DEFAULT_MODEL;
      const { menu, usage, cached, readable, poorQuality, enriched } = await extractMenu(images, {
        targetLang: body.targetLang?.trim() || "polski",
        restaurantHint: body.restaurantHint?.trim() || undefined,
        locationHint: body.locationHint?.trim() || undefined,
        cuisineHint: body.cuisineHint?.trim() || undefined,
        model,
        enrichModel: isModelId(body.enrichModel) ? body.enrichModel : undefined,
        structureOnly: body.structureOnly === true,
        knownSections: Array.isArray(body.knownSections) ? body.knownSections.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 40) : undefined,
        nearbyVenues: sanitizeNearby(body.nearbyVenues),
        // Postęp odczytu na żywo: krok z licznikiem pozycji (gdy wzrośnie).
        onProgress: wantSteps
          ? (p) => {
              latestItems = p.items;
              s.write(JSON.stringify({ phase: "extracting", elapsedMs: Date.now() - t0, items: p.items }) + "\n").catch(() => {});
            }
          : undefined,
        // Każda sparsowana pozycja NA ŻYWO — apka pokazuje nazwę i od razu dociąga zdjęcie poglądowe.
        onItem: wantSteps
          ? (it) => {
              s.write(JSON.stringify({ phase: "item", ...it }) + "\n").catch(() => {});
            }
          : undefined,
        // Wzbogacona pozycja NA ŻYWO (opis + photo_query) — apka uzupełnia kartę i dociąga zdjęcie.
        onEnrichItem: wantSteps
          ? (it) => {
              s.write(JSON.stringify({ phase: "enrich-item", ...it }) + "\n").catch(() => {});
            }
          : undefined,
        // Nazwa lokalu NA ŻYWO (z szyldu/okładki) — gdy tylko model ją ustali.
        onMeta: wantSteps
          ? (m) => {
              s.write(JSON.stringify({ phase: "meta", ...m }) + "\n").catch(() => {});
            }
          : undefined,
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
      // Model skanujący stwierdził „za słaba jakość" (np. mimo że peek przepuścił) → zapamiętaj złe
      // kadry (nie marnuj modelu ponownie) i daj apce sygnał, by ostrzec usera i nie wysyłać tego znów.
      const lowQuality = readable === false; // nic nie odczytano → odrzuć + zapamiętaj jako zły kadr
      if (lowQuality) {
        for (const img of images) void cacheSet("bad-photo", cacheKey("bad-photo", photoHash(img.base64)), { reason: "skan: model nie odczytał menu (za słaba jakość)", at: Date.now() });
      }
      // Czytelne, ale SŁABA jakość (np. działy ok, pozycje za małe) → wynik może być NIEPEŁNY. NIE
      // rejestrujemy jako zły kadr (jest częściowo użyteczny), tylko ostrzegamy usera.
      const partialQuality = !lowQuality && poorQuality === true;
      await s.write(wantSteps ? JSON.stringify({ done: true, menu, usage, cached: !!cached, lowQuality, partialQuality, enriched: enriched !== false }) + "\n" : JSON.stringify({ menu, usage, cached: !!cached, lowQuality, partialQuality, enriched: enriched !== false }));
    } catch (e) {
      console.error("scan error:", e);
      const msg = `Odczyt menu nie powiódł się: ${(e as Error).message}`;
      await s.write(wantSteps ? JSON.stringify({ error: msg }) + "\n" : JSON.stringify({ error: msg }));
    } finally {
      clearInterval(keepalive);
    }
  });
});

// ─── ARCHITEKTURA B: streaming upload. Apka wysyła zdjęcia POJEDYNCZO (odporne — retry per zdjęcie,
// naturalny pasek postępu), serwer buforuje per SESJA i dopiero w /scan/run TNIE PO ROZMIARZE na partie
// modelu, skanuje (równolegle, z ciągłością grup) i streamuje strukturę. Serwer = autorytet wielkości. ───
interface ScanSession {
  params: { targetLang: string; restaurantHint?: string; locationHint?: string; cuisineHint?: string; model?: ModelId; enrichModel?: ModelId; nearbyVenues?: { name: string; cuisine?: string | null }[] };
  // index (kolejność dodania) → zdjęcie + takenAt (EXIF). Idempotentne (retry nadpisuje ten sam index).
  // KOLEJNOŚĆ DO AI ustalamy po `takenAt` (data zrobienia), z indeksem jako tie-breakerem — model dostaje
  // strony w kolejności, w jakiej user je fotografował.
  photos: Map<number, { base64: string; mediaType: MediaType; takenAt: number | null }>;
  createdAt: number;
}
const scanSessions = new Map<string, ScanSession>();
const SCAN_SESSION_TTL_MS = 5 * 60_000;
const MAX_SCAN_SESSIONS = 50; // sanity (chroni pamięć — apka 1-userowa, sesji mało)
const BATCH_BUDGET_B64 = 28_000_000; // budżet ROZMIARU partii modelu (znaki base64), zapas pod MAX_TOTAL_BASE64
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of scanSessions) if (now - s.createdAt > SCAN_SESSION_TTL_MS) scanSessions.delete(id);
}, 60_000);

/** Łączy struktury partii w jedno menu: sekcje po NAZWIE (ciągłość grup), pozycje dedup po `original`. */
function mergeStructureMenus(menus: Menu[]): Menu {
  const empty: Menu = { restaurant_name: null, restaurant_address: null, restaurant_language: "", cuisine: "nieokreślona", sections: [], notes: [] };
  if (menus.length === 0) return empty;
  if (menus.length === 1) return menus[0]!;
  const byName = new Map<string, MenuSection>();
  const order: string[] = [];
  const seen = new Set<string>();
  for (const m of menus) for (const s of m.sections) {
    let sec = byName.get(s.name);
    if (!sec) { sec = { name: s.name, name_translated: s.name_translated, items: [] }; byName.set(s.name, sec); order.push(s.name); }
    for (const it of s.items) if (!seen.has(it.original)) { seen.add(it.original); sec.items.push(it); }
  }
  return {
    restaurant_name: menus.find((m) => m.restaurant_name)?.restaurant_name ?? null,
    restaurant_address: menus.find((m) => m.restaurant_address)?.restaurant_address ?? null,
    restaurant_language: menus.find((m) => m.restaurant_language)?.restaurant_language ?? "",
    cuisine: menus.find((m) => m.cuisine && m.cuisine !== "nieokreślona")?.cuisine ?? menus[0]!.cuisine,
    sections: order.map((n) => byName.get(n)!),
    notes: menus.flatMap((m) => m.notes ?? []),
  };
}

app.post("/scan/start", async (c) => {
  let body: ScanBody;
  try { body = await c.req.json<ScanBody>(); } catch { return c.json({ error: "Nieprawidłowy JSON." }, 400); }
  if (scanSessions.size >= MAX_SCAN_SESSIONS) {
    const oldest = [...scanSessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) scanSessions.delete(oldest[0]);
  }
  const sessionId = randomUUID();
  scanSessions.set(sessionId, {
    params: {
      targetLang: body.targetLang?.trim() || "polski",
      restaurantHint: body.restaurantHint?.trim() || undefined,
      locationHint: body.locationHint?.trim() || undefined,
      cuisineHint: body.cuisineHint?.trim() || undefined,
      model: isModelId(body.model) ? body.model : undefined,
      enrichModel: isModelId(body.enrichModel) ? body.enrichModel : undefined,
      nearbyVenues: sanitizeNearby(body.nearbyVenues),
    },
    photos: new Map(),
    createdAt: Date.now(),
  });
  return c.json({ sessionId });
});

interface ScanPhotoBody { sessionId?: string; index?: number; base64?: string; mediaType?: string; takenAt?: number }
app.post("/scan/photo", async (c) => {
  let body: ScanPhotoBody;
  try { body = await c.req.json<ScanPhotoBody>(); } catch { return c.json({ error: "Nieprawidłowy JSON." }, 400); }
  const s = body.sessionId ? scanSessions.get(body.sessionId) : undefined;
  if (!s) return c.json({ error: "Sesja nieznana lub wygasła — zacznij skan od nowa." }, 404);
  if (!body.base64) return c.json({ error: "Brak base64 zdjęcia." }, 400);
  if (!body.mediaType || !ALLOWED_MEDIA.has(body.mediaType as MediaType)) {
    return c.json({ error: "mediaType musi być image/jpeg, image/png lub image/webp." }, 400);
  }
  const b64 = body.base64.includes(",") ? body.base64.split(",")[1]! : body.base64;
  if (b64.length > BATCH_BUDGET_B64) return c.json({ error: "Pojedyncze zdjęcie za duże." }, 413);
  const idx = Number.isFinite(body.index) ? Number(body.index) : s.photos.size;
  if (s.photos.size >= 40 && !s.photos.has(idx)) return c.json({ error: "Za dużo zdjęć w jednym skanie (max 40)." }, 413);
  s.photos.set(idx, { base64: b64, mediaType: body.mediaType as MediaType, takenAt: Number.isFinite(body.takenAt) ? Number(body.takenAt) : null });
  s.createdAt = Date.now(); // odśwież TTL
  return c.json({ ok: true, received: s.photos.size });
});

interface ScanRunBody { sessionId?: string; stream?: boolean; nearbyVenues?: { name?: string; cuisine?: string | null }[] }
app.post("/scan/run", async (c) => {
  let body: ScanRunBody;
  try { body = await c.req.json<ScanRunBody>(); } catch { return c.json({ error: "Nieprawidłowy JSON." }, 400); }
  const s = body.sessionId ? scanSessions.get(body.sessionId) : undefined;
  if (!s) return c.json({ error: "Sesja nieznana lub wygasła — zacznij skan od nowa." }, 404);
  if (s.photos.size === 0) return c.json({ error: "Brak zdjęć w sesji." }, 400);
  // Lokale „w pobliżu" apka liczy RÓWNOLEGLE z uploadem i podaje dopiero tu (zero opóźnienia startu).
  if (Array.isArray(body.nearbyVenues)) s.params.nearbyVenues = sanitizeNearby(body.nearbyVenues);
  if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);

  // Kolejność DO AI: po dacie zrobienia (takenAt), index jako tie-breaker — strony tak, jak fotografował
  // user. Potem tnij PO ROZMIARZE na partie modelu (serwer = autorytet). +sufit 15 (bezpiecznik timeoutu).
  const ordered: InputImage[] = [...s.photos.entries()]
    .sort((a, b) => (a[1].takenAt ?? Infinity) - (b[1].takenAt ?? Infinity) || a[0] - b[0])
    .map(([, img]) => ({ base64: img.base64, mediaType: img.mediaType }));
  scanSessions.delete(body.sessionId!);
  const batches: InputImage[][] = [];
  let cur: InputImage[] = []; let curB = 0;
  for (const img of ordered) {
    if (cur.length > 0 && (curB + img.base64.length > BATCH_BUDGET_B64 || cur.length >= 15)) { batches.push(cur); cur = []; curB = 0; }
    cur.push(img); curB += img.base64.length;
  }
  if (cur.length) batches.push(cur);

  const wantSteps = body.stream === true;
  const t0 = Date.now();
  const model = s.params.model && isModelId(s.params.model) ? s.params.model : DEFAULT_MODEL;
  return stream(c, async (st) => {
    if (wantSteps) await st.write(JSON.stringify({ phase: "received", images: ordered.length }) + "\n");
    const keepalive = setInterval(() => { st.write(wantSteps ? JSON.stringify({ phase: "extracting", elapsedMs: Date.now() - t0 }) + "\n" : " ").catch(() => {}); }, wantSteps ? 2000 : 5000);
    try {
      const results: Menu[] = [];
      const tot = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
      let cachedCount = 0; // ile partii wróciło z cache (wszystkie → skan „bez kosztu modelu")
      let knownSections: string[] = [];
      const runOne = async (bi: number) => {
        const { menu, usage, cached } = await extractMenu(batches[bi]!, {
          targetLang: s.params.targetLang, restaurantHint: s.params.restaurantHint, locationHint: s.params.locationHint,
          cuisineHint: s.params.cuisineHint, model, enrichModel: s.params.enrichModel, structureOnly: true,
          knownSections: bi === 0 ? undefined : knownSections,
          // Lista „w pobliżu" tylko do PIERWSZEJ partii (ma okładkę/szyld) — venue_match emitowany raz.
          nearbyVenues: bi === 0 ? s.params.nearbyVenues : undefined,
          onItem: wantSteps ? (it) => { st.write(JSON.stringify({ phase: "item", ...it }) + "\n").catch(() => {}); } : undefined,
          onMeta: wantSteps ? (m) => { st.write(JSON.stringify({ phase: "meta", ...m }) + "\n").catch(() => {}); } : undefined,
        });
        results[bi] = menu;
        if (cached) cachedCount++;
        tot.inputTokens += usage.inputTokens; tot.outputTokens += usage.outputTokens; tot.costUsd += usage.costUsd;
      };
      await runOne(0);
      knownSections = (results[0]?.sections ?? []).map((x) => x.name).filter((n) => n && !/sin t[ií]tulo|untitled|bez tyt|^\(/i.test(n));
      if (batches.length > 1) {
        let next = 1;
        const worker = async () => { while (next < batches.length) { const bi = next++; await runOne(bi).catch(() => { results[bi] = mergeStructureMenus([]); }); } };
        await Promise.all(Array.from({ length: Math.min(3, batches.length - 1) }, worker));
      }
      const merged = mergeStructureMenus(results.filter(Boolean));
      const cached = cachedCount === batches.length; // wszystkie partie z cache → bez kosztu modelu
      logEvent({ type: "scan", op: "scan", model, provider: apiTag(model), inputTokens: tot.inputTokens, outputTokens: tot.outputTokens, costUsd: tot.costUsd, data: { images: ordered.length, sections: merged.sections.length, items: merged.sections.reduce((n, sec) => n + sec.items.length, 0), targetLang: s.params.targetLang, restaurant: merged.restaurant_name ?? null, cuisine: merged.cuisine ?? null, mode: "session", cached } });
      await st.write(wantSteps ? JSON.stringify({ done: true, menu: merged, usage: tot, enriched: false, cached }) + "\n" : JSON.stringify({ menu: merged, usage: tot, enriched: false, cached }));
    } catch (e) {
      console.error("scan/run error:", e);
      await st.write(JSON.stringify({ error: `Skan nie powiódł się: ${(e as Error).message}` }) + "\n");
    } finally {
      clearInterval(keepalive);
    }
  });
});

interface EnrichBody {
  menu?: Menu;
  targetLang?: string;
  locationHint?: string;
  cuisineHint?: string;
  model?: string;
  enrichModel?: string;
  stream?: boolean;
}

// FAZA B (apka): enrich gotowej STRUKTURY menu — tłumaczenia/opisy/photo_query, tekstowo (BEZ zdjęć).
// Apka po Fazie A (struktura) wchodzi do menu, a tu w tle uzupełnia pozycje W MIEJSCU (strumień
// enrich-item po `original`). Enrich ma cache per pozycja → przy powtórce/replayu prawie darmowy.
app.post("/enrich", async (c) => {
  if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);
  let body: EnrichBody;
  try {
    body = await c.req.json<EnrichBody>();
  } catch {
    return c.json({ error: "Nieprawidłowy JSON." }, 400);
  }
  if (!body.menu?.sections?.length) return c.json({ error: "Brak struktury menu do wzbogacenia." }, 400);
  const structure = menuToStructure(body.menu);
  const model = isModelId(body.enrichModel) ? body.enrichModel : isModelId(body.model) ? body.model : DEFAULT_MODEL;
  const wantSteps = body.stream === true;
  const t0 = Date.now();
  return stream(c, async (s) => {
    if (wantSteps) await s.write(JSON.stringify({ phase: "received" }) + "\n");
    const keepalive = setInterval(() => {
      s.write(wantSteps ? JSON.stringify({ phase: "extracting", elapsedMs: Date.now() - t0 }) + "\n" : " ").catch(() => {});
    }, wantSteps ? 2000 : 5000);
    try {
      const { menu, usage } = await enrichMenu(
        structure,
        {
          targetLang: body.targetLang?.trim() || "polski",
          locationHint: body.locationHint?.trim() || undefined,
          cuisineHint: body.cuisineHint?.trim() || undefined,
          onEnrichItem: wantSteps ? (it) => { s.write(JSON.stringify({ phase: "enrich-item", ...it }) + "\n").catch(() => {}); } : undefined,
        },
        model,
      );
      logEvent({ type: "scan", op: "enrich", model, provider: apiTag(model), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd, data: { items: menu.sections.reduce((n, sec) => n + sec.items.length, 0), targetLang: body.targetLang?.trim() || "polski" } });
      await s.write(wantSteps ? JSON.stringify({ done: true, menu, usage }) + "\n" : JSON.stringify({ menu, usage }));
    } catch (e) {
      console.error("enrich error:", e);
      const msg = `Wzbogacanie menu nie powiodło się: ${(e as Error).message}`;
      await s.write(wantSteps ? JSON.stringify({ error: msg }) + "\n" : JSON.stringify({ error: msg }));
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
    const { text: info, usage, cached } = await describeDish({
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
      data: { dish: body.name.trim(), cached: !!cached, restaurant: body.restaurant?.trim() || null },
    });
    return c.json({ info, usage, cached: !!cached });
  } catch (e) {
    console.error("dish-info error:", e);
    return c.json({ error: `Nie udało się pobrać informacji: ${(e as Error).message}` }, 502);
  }
});

// „Szybki podgląd" — lekka ocena 1 zdjęcia na żywo z aparatu (kuchnia / nazwa / czy to menu).
app.post("/quick-peek", async (c) => {
  try {
    const body = (await c.req.json()) as { image?: { base64?: string; mediaType?: string }; model?: string };
    if (!body.image?.base64) return c.json({ error: "Brak zdjęcia." }, 400);
    const imageHash = photoHash(body.image.base64);
    // Znany „zły kadr" (za słaba jakość) → werdykt od razu, BEZ wołania modelu (oszczędność);
    // apka i tak zablokuje wysyłkę. To realizuje „nie skanuj/nie wysyłaj ponownie".
    const known = await cacheGet<{ reason?: string }>("bad-photo", cacheKey("bad-photo", imageHash), { op: "quick-peek" });
    if (known) return c.json({ isMenu: false, cuisine: "", restaurantName: "", readable: false, bad: true, badReason: known.reason ?? "za słaba jakość", imageHash, usage: ZERO_USAGE });
    if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);
    const model = isModelId(body.model) ? body.model : DEFAULT_MODEL;
    const { result, usage } = await quickPeek(
      { base64: body.image.base64, mediaType: body.image.mediaType || "image/jpeg" },
      model,
    );
    // „Nic sensownego do odczytania" → zapamiętaj hash jako zły (serwer wie + nie skanuje ponownie).
    const bad = !result.readable;
    if (bad) void cacheSet("bad-photo", cacheKey("bad-photo", imageHash), { reason: "peek: zdjęcie nieczytelne / za słaba jakość", at: Date.now() });
    logEvent({
      type: "ai",
      op: "quick-peek",
      model,
      provider: apiTag(model),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      data: { isMenu: result.isMenu, cuisine: result.cuisine, readable: result.readable, bad },
    });
    return c.json({ ...result, bad, imageHash, usage });
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
  branded?: boolean; // markowy produkt → generyk zamiast szukania u lokalu
  cuisine?: string; // kontekst kuchni — poprawia trafność weryfikacji
  website?: string; // strona lokalu (z Google Places) — dodatkowe źródło zdjęć
  num?: number;
  verify?: boolean; // weryfikacja vision (DOMYŚLNIE WŁĄCZONA; wyłącz przez verify:false)
  verifyModel?: string; // model weryfikacji zdjęć (Claude/GPT). Domyślnie Sonnet.
  representativeOnly?: boolean; // tylko poglądowe (Wikimedia, free, bez SerpApi/vision) — do tła
  takeAll?: boolean; // „bierz wszystko": zwróć też odrzucone (oznaczone) + wszystkie dobre, posortowane
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
      branded: body.branded,
      cuisine: body.cuisine,
      website: body.website,
      num: body.num,
      verify: body.verify,
      verifyModel,
      representativeOnly: body.representativeOnly,
      takeAll: body.takeAll,
    });
    logEvent({
      type: "ai",
      op: "dish-photos",
      model: verifyModel,
      provider: apiTag(verifyModel),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      // Zapamiętujemy KANDYDATÓW (url + ocena + werdykt + cache) — żeby w labie/statystykach móc zobaczyć,
      // co realnie wyszukano, jak ocenione i co trafiło do cache (+ podgląd fotek do oceny „czy słusznie").
      data: {
        dish: body.dish.trim(), resultCount: photos.length, representativeOnly: !!body.representativeOnly,
        restaurant: body.restaurantName?.trim() || body.restaurantHint?.trim() || null,
        cached: !!debug?.fromCache,
        // SUROWE zwroty API per provider (przed weryfikacją) — same linki, do podglądu.
        searched: (debug?.searched ?? []).map((s) => ({ provider: s.provider, urls: s.urls.slice(0, 12) })),
        // Kandydaci z OCENĄ, werdyktem i flagą `final` (czy trafił do zwróconej listy) — do dopasowania
        // oceny do surowych zwrotów (które odrzucone i za ile punktów).
        cands: (() => { const finalUrls = new Set(photos.map((p) => p.url)); return (debug?.steps ?? []).flatMap((st) =>
          (st.candidates ?? []).map((c) => ({ u: c.url, s: c.score != null ? +c.score.toFixed(2) : null, p: !!c.passed, fv: !!c.fromVenue, fin: finalUrls.has(c.url), tier: st.tier })),
        ).slice(0, 30); })(),
      },
    });
    return c.json({ photos, usage, debug });
  } catch (e) {
    console.error("dish-photos error:", e);
    return c.json({ error: `Wyszukiwanie zdjęć nie powiodło się: ${(e as Error).message}` }, 502);
  }
});

/** Czy URL obrazu jest MARTWY (serwer nie pobiera go jako obrazu). Chroni samonaprawę przed
 *  wymuszaniem drogich przeszukań: dopiero potwierdzona śmierć URL-a pozwala szukać od nowa. */
async function isImageDead(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    let res = await fetch(url, { method: "HEAD", signal: ctrl.signal }).catch(() => null);
    if (!res || (!res.ok && res.status !== 405)) {
      res = await fetch(url, { method: "GET", signal: ctrl.signal }).catch(() => null); // HEAD bywa blokowany
    }
    if (!res || !res.ok) return true;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    return ct ? !ct.startsWith("image/") : false; // HTML/strona błędu zamiast obrazu = martwy
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// SAMONAPRAWA cache zdjęć poglądowych: apka, gdy CACHE’owane zdjęcie się nie wczyta, prosi o
// odświeżenie. Serwer NAJPIERW sam sprawdza, czy URL faktycznie martwy (anty‑oszustwo) — i tylko
// wtedy unieważnia wpis, szuka świeżych (płatne) i aktualizuje cache. Żywy URL → bez ponownych kosztów.
app.post("/dish-photo-refresh", async (c) => {
  let b: DishPhotosBody & { deadUrl?: string };
  try {
    b = await c.req.json();
  } catch {
    return c.json({ error: "Nieprawidłowy JSON." }, 400);
  }
  if (!b.dish?.trim() || !b.deadUrl) return c.json({ error: "Brak dish/deadUrl." }, 400);

  if (!(await isImageDead(b.deadUrl))) {
    return c.json({ refreshed: false, reason: "URL żyje (serwer pobrał obraz) — bez ponownego szukania.", photos: null });
  }
  if (await budgetExceeded()) return c.json({ error: budgetMsg() }, 402);

  const verifyModel = b.verifyModel?.trim() || "claude-sonnet-4-6";
  try {
    await cacheDelete(reprPhotoCacheKey({ dish: b.dish.trim(), photoQuery: b.photoQuery, cuisine: b.cuisine, verifyModel, num: b.num, verify: b.verify }));
    const { photos, usage, debug } = await runDishPhotos({
      dish: b.dish.trim(), photoQuery: b.photoQuery, photoQueryLocal: b.photoQueryLocal,
      cuisine: b.cuisine, num: b.num, verify: b.verify, verifyModel, representativeOnly: true,
    });
    logEvent({
      type: "ai", op: "dish-photo-refresh", model: verifyModel, provider: apiTag(verifyModel),
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd,
      data: { dish: b.dish.trim(), resultCount: photos.length, deadUrl: b.deadUrl.slice(0, 200) },
    });
    return c.json({ refreshed: true, photos, usage, debug });
  } catch (e) {
    console.error("dish-photo-refresh error:", e);
    return c.json({ error: `Odświeżenie zdjęć nie powiodło się: ${(e as Error).message}` }, 502);
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
    { provider: "app", label: "Apka ↔ serwer", paid: false, configured: true },
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
      bytesSent: r?.bytesSent ?? 0,
      bytesRecv: r?.bytesRecv ?? 0,
      entries: r?.entries ?? [],
    };
  });
  const other = reps.get("other");
  if (other && other.total > 0) {
    providers.push({ label: "Inne", paid: false, configured: true, ...other });
  }
  // Sumy zbiorcze — łączny ruch (egress płatny na Railway) i koszt AI. Koszt transferu liczymy
  // z egressu (bytesSent) wg stawki EGRESS_USD_PER_GB (Railway ~$0.10/GB). Total = AI + transfer.
  const egressUsdPerGB = Number(process.env.EGRESS_USD_PER_GB) || 0.1;
  const sum = providers.reduce(
    (a, p) => ({ bytesSent: a.bytesSent + p.bytesSent, bytesRecv: a.bytesRecv + p.bytesRecv, costUsd: a.costUsd + p.costUsd }),
    { bytesSent: 0, bytesRecv: 0, costUsd: 0 },
  );
  const dataCostUsd = (sum.bytesSent / 1e9) * egressUsdPerGB;
  const totals = { ...sum, egressUsdPerGB, dataCostUsd, grandTotalUsd: sum.costUsd + dataCostUsd };
  return c.json({ now: Date.now(), providers, totals });
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

// Cache treści (repr-photos/dish-info/vision/struktura/enrich) — podgląd dla LAB. To PRODUKCYJNY
// cache (gdzie realnie żyją wpisy); lokalny lab cache jest pusty, więc lab pyta tutaj. Token chroni globalnie.
app.get("/cache-stats", async (c) => {
  try {
    return c.json({ ...(await cacheStats()), sessionHits: cacheHitsSnapshot() });
  } catch (e) {
    return c.json({ enabled: false, l1: 0, rows: [], error: (e as Error).message }, 200);
  }
});
app.get("/cache-browse", async (c) => {
  try {
    const kind = c.req.query("kind") || undefined;
    const q = c.req.query("q") || undefined;
    const limit = Number(c.req.query("limit")) || 100;
    return c.json(await cacheBrowse({ kind, q, limit }));
  } catch (e) {
    return c.json({ source: "l1", rows: [], error: (e as Error).message }, 200);
  }
});
app.get("/cache-size", async (c) => {
  try {
    return c.json(await cacheSize());
  } catch (e) {
    return c.json({ enabled: false, bytes: 0, rows: 0, error: (e as Error).message }, 200);
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

// ===== SAMPLE ONLINE: apka wysyła migawki, lab je pobiera/importuje (po imporcie zip kasowany) =====
const MAX_SAMPLE_BYTES = 15_000_000; // ~15 MB zip / sampel (zabezpieczenie rozmiaru)

// Apka: wyślij migawkę. Body: { hash, meta, zipBase64 }. Dedup po hashu.
app.post("/samples", async (c) => {
  if (!samplesEnabled()) return c.json({ error: "Sample online wyłączone (brak bazy)." }, 503);
  let b: { hash?: string; meta?: Record<string, unknown>; zipBase64?: string; target?: string };
  try { b = await c.req.json(); } catch { return c.json({ error: "Nieprawidłowy JSON." }, 400); }
  if (!b.hash || !b.zipBase64) return c.json({ error: "Brak hash/zipBase64." }, 400);
  const zip = Buffer.from(b.zipBase64.includes(",") ? b.zipBase64.split(",")[1]! : b.zipBase64, "base64");
  if (zip.length === 0 || zip.length > MAX_SAMPLE_BYTES) return c.json({ error: `Zip pusty lub za duży (limit ${Math.round(MAX_SAMPLE_BYTES / 1e6)} MB).` }, 413);
  // target: 'lab' (apka→lab, domyślnie) albo 'app' (lab→apka, kolejka do importu w apce).
  const target = b.target === "app" ? "app" : "lab";
  try {
    const r = await saveSample(b.hash, b.meta ?? {}, zip, c.req.header("x-install-id") || undefined, target);
    return c.json(r);
  } catch (e) {
    console.error("samples upload error:", e);
    return c.json({ error: (e as Error).message }, 500);
  }
});

// Lista sampli. ?pending=1 → tylko nieimportowane. ?target=app → kolejka lab→apka (domyślnie 'lab').
app.get("/samples", async (c) => {
  const pending = c.req.query("pending") === "1";
  const target = c.req.query("target") === "app" ? "app" : "lab";
  return c.json({ enabled: samplesEnabled(), store: storeMode(), samples: await listSamples(pending, target) });
});

// Lab: pobierz zip sampla do importu.
app.get("/samples/:id/zip", async (c) => {
  const id = Number(c.req.param("id"));
  const zip = await getSampleZip(id);
  if (!zip) return c.json({ error: "Brak zipu (sampel nie istnieje lub już zaimportowany)." }, 404);
  return c.body(new Uint8Array(zip), 200, { "Content-Type": "application/zip" });
});

// Lab: po udanym imporcie — oznacz zaimportowany i skasuj zip (hash+meta zostają na zawsze).
app.post("/samples/:id/imported", async (c) => {
  await markImported(Number(c.req.param("id")));
  return c.json({ ok: true });
});

// Cofnięcie wysyłki (usuń całkowicie).
app.delete("/samples/:id", async (c) => {
  await deleteSample(Number(c.req.param("id")));
  return c.json({ ok: true });
});

// Apka: status migawek po hashach (na serwerze? zaimportowane?). Body: { hashes: string[] }.
app.post("/samples/status", async (c) => {
  let b: { hashes?: string[] };
  try { b = await c.req.json(); } catch { return c.json({ error: "Nieprawidłowy JSON." }, 400); }
  return c.json({ enabled: samplesEnabled(), status: await statusByHashes(b.hashes ?? []) });
});

// ===== BŁĘDY KLIENTA: apka zgłasza każdy błąd → trwały log (Postgres) → zakładka „Błędy" w labie ====
app.post("/client-error", async (c) => {
  let b: { message?: string; stack?: string; label?: string; context?: unknown; appVersion?: string; platform?: string };
  try { b = await c.req.json(); } catch { return c.json({ error: "Nieprawidłowy JSON." }, 400); }
  if (!b.message) return c.json({ error: "Brak message." }, 400);
  logEvent({
    type: "client-error",
    op: (b.label || "error").slice(0, 60),
    data: {
      message: String(b.message).slice(0, 1000),
      stack: b.stack ? String(b.stack).slice(0, 4000) : null,
      context: b.context ?? null,
      appVersion: b.appVersion ?? null,
      platform: b.platform ?? null,
    },
  });
  return c.json({ ok: true });
});

// Lab: pobierz ostatnie błędy klienta (z install_id do grupowania per instancja).
app.get("/client-errors", async (c) => {
  const limit = Number(c.req.query("limit")) || 300;
  return c.json({ errors: await getClientErrors(limit) });
});

// Apka: rejestruje/odświeża instalację (urządzenie + wersja) — wołane na starcie.
app.post("/install/register", async (c) => {
  let b: { installId?: string; deviceModel?: string; brand?: string; osName?: string; osVersion?: string; appVersion?: string };
  try { b = await c.req.json(); } catch { return c.json({ error: "Nieprawidłowy JSON." }, 400); }
  const installId = b.installId || c.req.header("x-install-id") || "";
  if (!installId) return c.json({ error: "Brak installId." }, 400);
  await upsertInstall({ installId, deviceModel: b.deviceModel, brand: b.brand, osName: b.osName, osVersion: b.osVersion, appVersion: b.appVersion });
  return c.json({ ok: true });
});

// Lab: lista instalacji ze statystyką (urządzenie, wersja, od kiedy/ostatnia aktywność, skany, koszt, błędy).
app.get("/installs", async (c) => c.json({ installs: await getInstalls() }));

// ========= ⚠️ JEDNORAZOWE NAPRAWY DANYCH (NIE rdzeń — logika w dataFixes.ts) =========
// Do łatania historii ze STARYCH buildów. Po wdrożeniu nowej apki CAŁY ten blok + dataFixes.ts +
// proxy/przycisk w labie można usunąć (nic z rdzenia od nich nie zależy). Chronione tokenem (auth).

// Oznacz zdarzenia REALNYCH urządzeń jako source=app (po modelu i/lub install_id). Idempotentny.
app.post("/admin/backfill-app-source", async (c) => {
  const b = await c.req.json<{ deviceModels?: string[]; installIds?: string[] }>().catch(() => ({}) as { deviceModels?: string[]; installIds?: string[] });
  const installIds = (b.installIds ?? []).map((m) => m.trim()).filter(Boolean);
  const models = b.deviceModels?.length ? b.deviceModels.map((m) => m.trim()).filter(Boolean) : (installIds.length ? [] : ["iPhone 17 Pro"]);
  const res = await backfillAppSource({ deviceModels: models, installIds });
  return c.json({ ok: true, ...res, deviceModels: models, installIds });
});

// Przypisz SIEROTY (logi bez install_id, np. /place-photo) do instancji/sesji najbliższego w czasie loga.
app.post("/admin/attribute-orphans", async (c) => {
  const b = await c.req.json<{ maxGapSec?: number }>().catch(() => ({}) as { maxGapSec?: number });
  const res = await attributeOrphansByTime(b.maxGapSec && b.maxGapSec > 0 ? b.maxGapSec : 900);
  return c.json({ ok: true, ...res });
});
// Nadaj syntetyczny sessionId starym zdarzeniom (bez sessionId) → baza może grupować sesje (GROUP BY sessionId).
app.post("/admin/backfill-sessions", async (c) => {
  const res = await backfillSyntheticSessions();
  return c.json({ ok: true, ...res });
});
// ========= /JEDNORAZOWE NAPRAWY DANYCH =========

// Podsumowania SESJI w okresie — agregacja w SQL (GROUP BY sessionId), bez ładowania wszystkich zdarzeń.
app.get("/sessions", async (c) => {
  const period = c.req.query("period") || "all";
  const now = Date.now();
  const since = period === "today" ? now - 24 * 3600e3 : period === "7d" ? now - 7 * 24 * 3600e3 : period === "30d" ? now - 30 * 24 * 3600e3 : 0;
  const source = c.req.query("source") || "all";
  const [sessions, counts] = await Promise.all([getSessions({ since: since || undefined, source }), getSourceCounts(since || undefined)]);
  return c.json({ sessions, ...counts, egressUsdPerGB: otherRate("egress", getPriceOverrides()) });
});
// Zdarzenia JEDNEJ sesji (flow) — dopiero gdy user kliknie sesję.
app.get("/session-events", async (c) => {
  const sid = c.req.query("sessionId");
  if (!sid) return c.json({ error: "Brak sessionId." }, 400);
  return c.json({ sessionId: sid, events: await getSessionEvents(sid) });
});

// WSPÓLNY CENNIK: lab edytuje override'y cen i WGRYWA je tutaj (cały obiekt). Serwer trzyma je w DB
// i stosuje do liczenia kosztu NOWYCH zdarzeń (AI w usage.ts, nie-AI w middleware) — bez rozjazdów.
app.get("/admin/price-overrides", (c) => c.json({ overrides: readPriceOverrides() }));
app.post("/admin/price-overrides", async (c) => {
  const b = await c.req.json<{ overrides?: PriceOverrides }>().catch(() => ({}) as { overrides?: PriceOverrides });
  const ov = b.overrides && typeof b.overrides === "object" ? b.overrides : {};
  await savePriceOverrides(ov);
  return c.json({ ok: true, overrides: readPriceOverrides() });
});

// Lab: nadaj nazwę instalacji.
app.post("/install/name", async (c) => {
  const b = await c.req.json<{ installId?: string; name?: string }>().catch(() => ({}) as { installId?: string; name?: string });
  if (!b.installId) return c.json({ error: "Brak installId." }, 400);
  await setInstallName(b.installId, b.name?.trim() || null);
  return c.json({ ok: true });
});

// Lab: wszystkie zdarzenia jednej INSTALACJI (skany, ai, sample, błędy) — wgląd „co robiła ta apka".
app.get("/install-activity", async (c) => {
  const installId = c.req.query("installId") || "";
  const limit = Number(c.req.query("limit")) || 200;
  return c.json({ installId, activity: await getInstallActivity(installId, limit) });
});

const port = Number(process.env.PORT) || 8787;
// hostname 0.0.0.0 — żeby telefon w tej samej sieci Wi-Fi dosięgnął serwera po LAN.
const server = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`🍝 MenuButBetter API na http://localhost:${info.port} (LAN: 0.0.0.0:${info.port})`);
  console.log(`   GET  /health`);
  console.log(`   POST /scan   { imageBase64, mediaType, targetLang?, restaurantHint? }`);
});

// GRACEFUL SHUTDOWN: przy redeployu Railway wysyła SIGTERM. Zamykamy serwer HTTP + pulę Postgresa
// i wychodzimy kodem 0 — dzięki temu kontener kończy się CZYSTO i Railway nie raportuje „crashed".
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — zamykam serwer i bazę…`);
  const timer = setTimeout(() => process.exit(0), 5000); // twardy limit, gdyby coś wisiało
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb();
  } catch {
    /* ignoruj */
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
