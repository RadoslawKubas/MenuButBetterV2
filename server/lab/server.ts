// Lokalny LAB do porównywania modeli na wyeksportowanych migawkach.
// Odpalasz: `npm run lab` w katalogu server/ → otwórz http://localhost:8799
// Reużywa logikę produkcyjną (extractMenu, quickPeek, findRestaurant) + klucze z server/.env.
//
// Co umie:
//  • wczytać eksport migawek (folder z metadata.json + images/),
//  • pokazać lokalizacje (EXIF/GPS) na mapie i dać oznaczyć PRAWDZIWY lokal (ground-truth),
//  • puścić te same operacje (peek / skan, opcjonalnie venue) dla WYBRANYCH modeli,
//  • porównać wyniki silnym modelem-sędzią (best + „good enough") i zapisać do results/.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import Anthropic from "@anthropic-ai/sdk";
import { extractMenu, contextText, SYSTEM as MENU_SYSTEM, type InputImage } from "../src/menu.ts";
import { quickPeek, SYSTEM as PEEK_SYSTEM, INSTRUCTION as PEEK_INSTRUCTION } from "../src/quickPeek.ts";
import { describeDish, SYSTEM as DESCRIBE_SYSTEM } from "../src/dishInfo.ts";
import { scoreDishPhotos, VERIFY_SYSTEM, verifyInstruction } from "../src/verifyPhotos.ts";
import { matchVenuePhotos, VENUE_SYSTEM, venueInstruction } from "../src/venuePhotos.ts";
import { genericWebImages } from "../src/dishPhotos.ts";
import { runDishPhotos } from "../src/dishPhotosPipeline.ts";
import { findRestaurant } from "../src/places.ts";
import { findTripAdvisor } from "../src/tripadvisor.ts";
import { openaiVisionJson } from "../src/openaiClient.ts";
import { MODELS, DEFAULT_MODEL, usesOpenAiApi, apiTag, type ModelId } from "../src/models.ts";
import { snapshot, cacheHitsSnapshot, modelSnapshot } from "../src/apiLog.ts";
import { cacheStats, cacheClear, cacheBrowse, cacheSize, initCache, type CacheKind } from "../src/cache.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "..", "samples", "captures"); // stare eksporty (do auto-migracji)
const RESULTS_DIR = join(HERE, "results");

// ===== CENY + LOG KOSZTÓW (lab) ============================================================
// Źródła cen — oficjalne strony (do ręcznej weryfikacji/aktualizacji, klikalne w UI).
const PRICE_SOURCES: Record<string, string> = {
  claude: "https://www.anthropic.com/pricing#api",
  openai: "https://openai.com/api/pricing/",
  google: "https://ai.google.dev/gemini-api/docs/pricing",
  egress: "https://railway.com/pricing",
  google_places: "https://mapsplatform.google.com/pricing/",
  serper: "https://serper.dev/",
  serpapi: "https://serpapi.com/pricing",
  tripadvisor: "https://www.tripadvisor.com/developers",
};
// Inne API + transfer — stawki orientacyjne (jednostka), nadpisywalne.
const OTHER_PRICES_DEFAULT: { key: string; label: string; unit: string; value: number; source: string }[] = [
  { key: "egress", label: "Transfer (Railway egress)", unit: "$/GB (wysłane)", value: 0.1, source: PRICE_SOURCES.egress! },
  { key: "google_places", label: "Google Places (details+photos)", unit: "$/1000 req", value: 17, source: PRICE_SOURCES.google_places! },
  { key: "serper", label: "Serper.dev (Google Images)", unit: "$/1000 req", value: 0.6, source: PRICE_SOURCES.serper! },
  { key: "serpapi", label: "SerpApi", unit: "$/1000 req", value: 10, source: PRICE_SOURCES.serpapi! },
  { key: "storage", label: "Cache storage (Postgres)", unit: "$/GB-mies.", value: 0.25, source: PRICE_SOURCES.egress! },
];

const PRICES_FILE = join(HERE, "prices-override.json");
function loadPriceOverrides(): Record<string, { in?: number; out?: number; value?: number }> {
  try {
    return JSON.parse(readFileSync(PRICES_FILE, "utf8"));
  } catch {
    return {};
  }
}
function savePriceOverrides(o: Record<string, { in?: number; out?: number; value?: number }>): void {
  writeFileSync(PRICES_FILE, JSON.stringify(o, null, 2));
}
/** Stawka „inna" (egress/api) z uwzględnieniem ręcznej podmiany. */
function otherRate(key: string): number {
  const ov = loadPriceOverrides()[key]?.value;
  return ov ?? OTHER_PRICES_DEFAULT.find((p) => p.key === key)?.value ?? 0;
}

// Log kosztów: jedna linia (JSONL) na operację labu — delta zużycia z apiLog (źródło prawdy).
const COSTLOG_FILE = join(RESULTS_DIR, "cost-log.jsonl");
interface CostDelta {
  provider: string;
  calls: number;
  inTok: number;
  outTok: number;
  costUsd: number; // koszt tokenów (realne ceny w chwili wywołania)
  bytesSent: number;
  bytesRecv: number;
}
// Zużycie tokenów PER MODEL (surowe liczby) — $ liczone osobno z AKTUALNEGO cennika, by zmiana
// ceny przeliczała statystyki. Provider „claude" może być Opus/Sonnet o różnych cenach.
interface ModelDelta { model: string; inTok: number; outTok: number; calls: number }
interface CostEntry {
  ts: number;
  ms: number;
  op: string; // np. "sim-scan", "sim-dish"
  meta: Record<string, unknown>; // model, danie, lokal itp.
  delta: CostDelta[]; // per provider: calls + bajty (do API/transferu); inTok/outTok/costUsd legacy
  models?: ModelDelta[]; // per model: tokeny do PRZELICZENIA z cennika (nowe wpisy)
  cacheHits?: number; // ile operacji obsłużono z CACHE (zero płatnego wywołania, tylko koszt bazy)
}
function providerTotals(): Record<string, Omit<CostDelta, "provider">> {
  const m: Record<string, Omit<CostDelta, "provider">> = {};
  for (const r of snapshot()) {
    m[r.provider] = { calls: r.total, inTok: r.inputTokens, outTok: r.outputTokens, costUsd: r.costUsd, bytesSent: r.bytesSent, bytesRecv: r.bytesRecv };
  }
  return m;
}
function modelTotals(): Record<string, { inTok: number; outTok: number; calls: number; costUsd: number }> {
  const m: Record<string, { inTok: number; outTok: number; calls: number; costUsd: number }> = {};
  for (const r of modelSnapshot()) m[r.model] = { inTok: r.inTok, outTok: r.outTok, calls: r.calls, costUsd: r.costUsd };
  return m;
}
/** Liczy deltę zużycia (apiLog: snapshot `before` vs teraz) i dopisuje wpis do logu kosztów. */
function recordCostDelta(op: string, meta: Record<string, unknown>, before: Record<string, Omit<CostDelta, "provider">>, t0: number, cacheBefore = 0, modelBefore: Record<string, { inTok: number; outTok: number; calls: number; costUsd: number }> = {}): void {
  const after = providerTotals();
  const cacheHits = cacheHitsSnapshot().total - cacheBefore;
  const delta: CostDelta[] = [];
  for (const [provider, a] of Object.entries(after)) {
    const b = before[provider] ?? { calls: 0, inTok: 0, outTok: 0, costUsd: 0, bytesSent: 0, bytesRecv: 0 };
    const d: CostDelta = {
      provider,
      calls: a.calls - b.calls,
      inTok: a.inTok - b.inTok,
      outTok: a.outTok - b.outTok,
      costUsd: a.costUsd - b.costUsd,
      bytesSent: a.bytesSent - b.bytesSent,
      bytesRecv: a.bytesRecv - b.bytesRecv,
    };
    if (d.calls || d.inTok || d.outTok || d.bytesSent || d.bytesRecv) delta.push(d);
  }
  // Per-model delta (do przeliczania $ z cennika).
  const modelAfter = modelTotals();
  const models: ModelDelta[] = [];
  for (const [model, a] of Object.entries(modelAfter)) {
    const b = modelBefore[model] ?? { inTok: 0, outTok: 0, calls: 0, costUsd: 0 };
    const md: ModelDelta = { model, inTok: a.inTok - b.inTok, outTok: a.outTok - b.outTok, calls: a.calls - b.calls };
    if (md.inTok || md.outTok || md.calls) models.push(md);
  }
  try {
    if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
    appendFileSync(COSTLOG_FILE, JSON.stringify({ ts: Date.now(), ms: Date.now() - t0, op, meta, delta, models, cacheHits } satisfies CostEntry) + "\n");
  } catch {
    /* log kosztów to dodatek — nie blokuj operacji */
  }
}
/** Owija operację: liczy DELTĘ zużycia (apiLog przed/po) i dopisuje do logu kosztów. */
async function withCostLog<T>(op: string, meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const before = providerTotals();
  const modelBefore = modelTotals();
  const cacheBefore = cacheHitsSnapshot().total;
  const t0 = Date.now();
  const res = await fn();
  recordCostDelta(op, meta, before, t0, cacheBefore, modelBefore);
  return res;
}
function readCostLog(): CostEntry[] {
  try {
    return readFileSync(COSTLOG_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CostEntry);
  } catch {
    return [];
  }
}
// ===========================================================================================

// --- Centralna BIBLIOTEKA sampli (jedno miejsce, „czysto i ładnie") --------------------------
//   lab/library/captures.json  — scalone metadane wszystkich migawek (dedup po sig),
//   lab/library/images/        — wszystkie zdjęcia.
// Do biblioteki doimportowujesz kolejne eksporty (folder lub ZIP).
const LIBRARY = join(HERE, "library");
const LIB_IMAGES = join(LIBRARY, "images");
const LIB_META = join(LIBRARY, "captures.json");
function ensureLibrary(): void {
  if (!existsSync(LIB_IMAGES)) mkdirSync(LIB_IMAGES, { recursive: true });
}

// --- Typy migawki z metadata.json --------------------------------------------------------
interface MetaImage {
  file: string;
  mediaType?: string;
  exifLocation?: { lat: number; lng: number };
}
interface MetaCapture {
  id: string;
  createdAt: number;
  name?: string;
  restaurantHint?: string;
  locationHint?: string;
  location?: { lat: number; lng: number } | null;
  locationSource?: string | null;
  /** Sygnatura WEJŚCIA migawki — stała dla tej samej treści, przeżywa ponowne eksporty. */
  sig?: string;
  /** GUID instancji apki, z której pochodzi migawka (eksport/plik) — do rozpoznania źródła w labie. */
  installId?: string;
  images: MetaImage[];
  result?: { restaurantName?: string | null; cuisine?: string; models?: Record<string, string>; menu?: unknown } | null;
  /** Zapisany skan z LABU (najlepsza wersja menu + lokal) — by testy zdjęć nie skanowały od nowa. */
  labScan?: LabScan;
}
interface LabScan {
  scanModel: string;
  at: number;
  peek: unknown;
  menu: { restaurantName: string | null; cuisine: string; itemCount: number };
  items: unknown[];
  venue: unknown;
}
interface GroundTruth {
  name: string;
  placeId?: string;
  lat?: number;
  lng?: number;
  address?: string;
}

function loadMeta(): MetaCapture[] {
  try {
    return JSON.parse(readFileSync(LIB_META, "utf8")) as MetaCapture[];
  } catch {
    return [];
  }
}
function saveMeta(caps: MetaCapture[]): void {
  ensureLibrary();
  writeFileSync(LIB_META, JSON.stringify(caps, null, 2));
}

// Doimportowanie migawek do biblioteki (dedup po sig||id; kopiuje zdjęcia do library/images/).
async function ingest(captures: MetaCapture[], readImage: (file: string) => Promise<Buffer | null>) {
  ensureLibrary();
  const existing = loadMeta();
  const keys = new Set(existing.map((c) => c.sig || c.id));
  let added = 0,
    skipped = 0;
  for (const cap of captures) {
    const key = cap.sig || cap.id;
    if (keys.has(key)) {
      skipped++;
      continue;
    }
    const newImages: MetaImage[] = [];
    for (const im of cap.images ?? []) {
      const buf = await readImage(im.file).catch(() => null);
      if (!buf) continue;
      const base = im.file.split("/").pop()!;
      writeFileSync(join(LIB_IMAGES, base), buf);
      newImages.push({ ...im, file: `images/${base}` });
    }
    existing.push({ ...cap, images: newImages });
    keys.add(key);
    added++;
  }
  saveMeta(existing);
  return { added, skipped };
}

async function ingestFolder(dir: string) {
  const metaP = join(dir, "metadata.json");
  if (!existsSync(metaP)) throw new Error("folder nie ma metadata.json");
  const caps = (JSON.parse(readFileSync(metaP, "utf8")).captures ?? []) as MetaCapture[];
  return ingest(caps, async (file) => {
    try {
      return readFileSync(join(dir, file));
    } catch {
      return null;
    }
  });
}

async function ingestZip(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const metaEntry = zip.file("metadata.json");
  if (!metaEntry) throw new Error("ZIP nie ma metadata.json");
  const caps = (JSON.parse(await metaEntry.async("string")).captures ?? []) as MetaCapture[];
  return ingest(caps, async (file) => {
    const e = zip.file(file);
    return e ? Buffer.from(await e.async("nodebuffer")) : null;
  });
}

// CENTRALNY zapis ground-truth (jeden plik dla wszystkich eksportów), KLUCZ = sig migawki.
// Dzięki temu przypisany lokal trzyma się TREŚCI migawki i przeżywa ponowny eksport (nowy folder).
const GT_CENTRAL = join(HERE, "ground-truth.json");
type GTEntry = GroundTruth & { id?: string; capturedAt?: number };
function loadGroundTruth(): Record<string, GTEntry> {
  try {
    return JSON.parse(readFileSync(GT_CENTRAL, "utf8"));
  } catch {
    return {};
  }
}
async function saveGroundTruth(gt: Record<string, GTEntry>): Promise<void> {
  await writeFile(GT_CENTRAL, JSON.stringify(gt, null, 2));
}
/** Ground-truth dla danej migawki — po sygnaturze (stabilnej), z fallbackiem po id. */
function gtFor(cap: MetaCapture): GTEntry | null {
  const store = loadGroundTruth();
  if (cap.sig && store[cap.sig]) return store[cap.sig];
  // fallback: stare wpisy mogły być kluczowane po id
  return store[cap.id] ?? null;
}

// Archiwum migawek (schowane z listy, BEZ kasowania) — lista sygnatur, przeżywa re-eksport.
const ARCHIVE_CENTRAL = join(HERE, "archived.json");
function loadArchived(): string[] {
  try {
    const v = JSON.parse(readFileSync(ARCHIVE_CENTRAL, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
async function saveArchived(list: string[]): Promise<void> {
  await writeFile(ARCHIVE_CENTRAL, JSON.stringify([...new Set(list)], null, 2));
}
function isArchived(cap: MetaCapture): boolean {
  const a = loadArchived();
  return (!!cap.sig && a.includes(cap.sig)) || a.includes(cap.id);
}

function imageInput(cap: MetaCapture, idx = 0): InputImage | null {
  const im = cap.images[idx];
  if (!im) return null;
  const buf = readFileSync(join(LIBRARY, im.file));
  return { base64: buf.toString("base64"), mediaType: (im.mediaType as InputImage["mediaType"]) || "image/jpeg" };
}
function allImageInputs(cap: MetaCapture): InputImage[] {
  return cap.images.map((_, i) => imageInput(cap, i)).filter((x): x is InputImage => !!x);
}

function norm(s?: string | null): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

// --- Operacje na pojedynczej migawce dla danego modelu -----------------------------------
async function opPeek(cap: MetaCapture, model: ModelId) {
  const img = imageInput(cap, 0);
  if (!img) return { ok: false, error: "brak zdjęcia" };
  const t0 = Date.now();
  const { result, usage } = await quickPeek(img, model);
  return { ok: true, ms: Date.now() - t0, cost: usage.costUsd, isMenu: result.isMenu, cuisine: result.cuisine, restaurantName: result.restaurantName };
}

async function opScan(cap: MetaCapture, model: ModelId, withVenue: boolean, gt?: GroundTruth) {
  const images = allImageInputs(cap);
  if (!images.length) return { ok: false, error: "brak zdjęć" };
  const t0 = Date.now();
  const { menu, usage } = await extractMenu(images, {
    targetLang: "polski",
    locationHint: cap.locationHint,
    model,
    noCache: true, // eksperymenty (porównania modeli) ZAWSZE świeże — uczciwy koszt/jakość
  });
  const items = menu.sections.reduce((n, s) => n + s.items.length, 0);
  const out: Record<string, unknown> = {
    ok: true,
    ms: Date.now() - t0,
    cost: usage.costUsd,
    restaurantName: menu.restaurant_name,
    cuisine: menu.cuisine,
    sections: menu.sections.length,
    items,
    menu,
  };
  if (withVenue && menu.restaurant_name) {
    const venue = await findRestaurant({
      name: menu.restaurant_name,
      lat: cap.location?.lat,
      lng: cap.location?.lng,
    }).catch(() => null);
    out.venue = venue ? { name: venue.name, placeId: venue.placeId, address: venue.address, location: venue.location } : null;
    if (gt) {
      out.venueMatch = !!venue && (venue.placeId === gt.placeId || (!!venue.name && norm(venue.name) === norm(gt.name)));
    }
  }
  return out;
}

// Operacje korzystające z ZAPISANEGO wyniku (menu/lokal) — izolują testowaną operację.
function savedDishes(cap: MetaCapture): { original: string; description?: string; photo_query?: string }[] {
  const menu = (cap.result as any)?.menu;
  if (!menu?.sections) return [];
  return menu.sections.flatMap((s: any) => s.items ?? []);
}

async function opDescribe(cap: MetaCapture, model: ModelId) {
  const menu = (cap.result as any)?.menu;
  const dishes = savedDishes(cap).slice(0, 3);
  if (!dishes.length) return { ok: false, error: "brak zapisanego menu (zeskanuj najpierw w apce)" };
  const t0 = Date.now();
  let cost = 0;
  const out: any[] = [];
  for (const it of dishes) {
    const { text, usage } = await describeDish({
      name: it.original,
      description: it.description,
      cuisine: menu.cuisine,
      location: cap.locationHint,
      targetLang: "polski",
      model,
    });
    cost += usage.costUsd;
    out.push({ dish: it.original, len: text.length, sample: text.slice(0, 500) });
  }
  return { ok: true, ms: Date.now() - t0, cost, count: out.length, dishes: out };
}

async function opVerify(cap: MetaCapture, model: ModelId) {
  const menu = (cap.result as any)?.menu;
  const dish = savedDishes(cap)[0];
  if (!dish) return { ok: false, error: "brak zapisanego menu" };
  const photos = await genericWebImages(dish.photo_query || dish.original, 5, menu?.cuisine).catch(() => []);
  const urls = photos.map((p) => p.url);
  if (!urls.length) return { ok: false, error: "brak kandydatów zdjęć (Serper)" };
  const t0 = Date.now();
  const { scores, usage } = await scoreDishPhotos(dish.original, urls, { cuisine: menu?.cuisine, model });
  const passed = scores.filter((s) => s >= 0.6).length;
  return { ok: true, ms: Date.now() - t0, cost: usage.costUsd, dish: dish.original, candidates: urls.length, passed, scores };
}

async function opVenuePhotos(cap: MetaCapture, model: ModelId) {
  const menu = (cap.result as any)?.menu;
  const rest = (cap.result as any)?.restaurant;
  if (!menu || !rest) return { ok: false, error: "brak menu/lokalu w zapisanym wyniku" };
  const dishes = savedDishes(cap).map((it) => it.original).filter(Boolean);
  const photoNames: string[] = rest.photoNames ?? [];
  const taPhotos = (rest.tripAdvisor?.photos ?? []).map((p: any) => ({ url: p.remoteUrl ?? p.url, caption: p.caption ?? null }));
  if (!photoNames.length && !taPhotos.length) return { ok: false, error: "brak zdjęć lokalu (Google/TA)" };
  const t0 = Date.now();
  const certain = rest.nameVerified !== false && !rest.guessedByLocation;
  const { matches, usage } = await matchVenuePhotos({ photoNames, taPhotos, dishes, cuisine: menu.cuisine, model, certain });
  return {
    ok: true,
    ms: Date.now() - t0,
    cost: usage.costUsd,
    pool: photoNames.length + taPhotos.length,
    matches: matches.length,
    sample: matches.slice(0, 8).map((m) => ({ dish: m.dish, source: m.source, conf: Number(m.confidence.toFixed(2)) })),
  };
}

// --- Sędzia: silny model porównuje ekstrakcje skanu (z obrazem menu) ----------------------
const anthropic = new Anthropic({ maxRetries: 3 });
const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    perModel: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          model: { type: "string" },
          completeness: { type: "integer", description: "0-100: ile pozycji menu wychwycił względem obrazu" },
          accuracy: { type: "integer", description: "0-100: poprawność nazw/cen/tłumaczeń" },
          notes: { type: "string" },
        },
        required: ["model", "completeness", "accuracy", "notes"],
      },
    },
    best: { type: "string", description: "model o najlepszej jakości" },
    goodEnough: { type: "string", description: "NAJTAŃSZY model wystarczająco dobry do tego menu" },
    summary: { type: "string" },
  },
  required: ["perModel", "best", "goodEnough", "summary"],
} as const;

// Wywołanie sędziego — provider-aware (Claude / OpenAI / Gemini) + tryb GŁĘBOKI (reasoning):
//  • Claude: extended thinking (budget_tokens) gdy deep,
//  • OpenAI (gpt-5*): reasoning_effort "high" gdy deep,
//  • Gemini: standardowo (compat).
async function runJudge(images: InputImage[], system: string, userText: string, model: string, deep: boolean) {
  if (usesOpenAiApi(model)) {
    const content: import("openai").OpenAI.Chat.Completions.ChatCompletionContentPart[] = images.map((im) => ({
      type: "image_url" as const,
      image_url: { url: `data:${im.mediaType};base64,${im.base64}` },
    }));
    content.push({ type: "text", text: userText });
    const { json } = await openaiVisionJson({
      op: "judge",
      model,
      system,
      content,
      schemaName: "verdict",
      schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
      maxCompletionTokens: deep ? 8000 : 3000,
      reasoningEffort: deep ? "high" : "medium",
    });
    return json ? JSON.parse(json) : null;
  }
  // Claude
  const content: Anthropic.ContentBlockParam[] = images.map((im) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: im.mediaType, data: im.base64 },
  }));
  content.push({ type: "text", text: userText });
  const req: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: deep ? 8000 : 2000,
    system,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA } },
  };
  if (deep) (req as Record<string, unknown>).thinking = { type: "enabled", budget_tokens: 4000 };
  const resp = await anthropic.messages.create(req);
  const text = resp.content.find((b) => b.type === "text");
  return text && text.type === "text" ? JSON.parse(text.text) : null;
}

async function judgeScan(cap: MetaCapture, scanByModel: Record<string, any>, judgeModel: string, deep: boolean) {
  const lines = Object.entries(scanByModel).map(([model, r]) => {
    const names = (r.menu?.sections ?? []).flatMap((s: any) => s.items.map((it: any) => it.original)).slice(0, 60);
    return `MODEL ${model}: lokal="${r.restaurantName ?? ""}", kuchnia="${r.cuisine ?? ""}", sekcje=${r.sections}, dania=${r.items}\n  pozycje: ${names.join(" | ")}`;
  });
  const system = "Jesteś rygorystycznym sędzią jakości ODCZYTU menu z obrazu. Oceniasz obiektywnie, względem tego co WIDAĆ na zdjęciu.";
  const user =
    "Oto ZDJĘCIA menu oraz wyniki ODCZYTU różnych modeli. Oceń każdy model: completeness " +
    "(ile pozycji wychwycił względem obrazu) i accuracy (poprawność nazw/cen/tłumaczeń), 0-100. " +
    "Wskaż best (najlepszy) i goodEnough (NAJTAŃSZY wystarczająco dobry do TEGO menu). Zwięzłe notatki po polsku.\n\n" +
    lines.join("\n");
  return runJudge(allImageInputs(cap), system, user, judgeModel, deep);
}

async function judgeDescribe(cap: MetaCapture, describeByModel: Record<string, any>, judgeModel: string, deep: boolean) {
  const blocks = Object.entries(describeByModel).map(([model, r]) => {
    const ds = (r.dishes ?? []).map((d: any) => `  • ${d.dish}: ${d.sample}`).join("\n");
    return `MODEL ${model}:\n${ds}`;
  });
  const system =
    "Jesteś rygorystycznym sędzią jakości OPISÓW dań. Oceniasz względem tego, co realnie wynika z nazwy dania, " +
    "kuchni i obrazu menu. Karzesz ZMYŚLENIA (składniki/fakty niezgodne z daniem/kuchnią).";
  const user =
    "Oto ZDJĘCIA menu oraz OPISY tych samych dań od różnych modeli. Oceń każdy model: completeness " +
    "(czy opis pokrywa kluczowe, prawdziwe informacje o daniu) i accuracy (poprawność, BRAK zmyśleń), 0-100. " +
    "Wskaż best i goodEnough (najtańszy wystarczająco dobry). Zwięzłe notatki po polsku.\n\n" +
    blocks.join("\n\n");
  return runJudge(allImageInputs(cap), system, user, judgeModel, deep);
}

// --- HTTP --------------------------------------------------------------------------------
const app = new Hono();
app.use("/*", cors());

app.get("/", (c) => c.html(readFileSync(join(HERE, "public", "index.html"), "utf8")));

app.get("/api/state", (c) => {
  const meta = loadMeta();
  const captures = meta.map((cap) => ({
    id: cap.id,
    name: cap.name ?? null,
    createdAt: cap.createdAt,
    locationHint: cap.locationHint ?? null,
    location: cap.location ?? null,
    locationSource: cap.locationSource ?? null,
    installId: cap.installId ?? null,
    exifLocations: cap.images.map((im) => im.exifLocation ?? null),
    images: cap.images.length,
    result: cap.result
      ? { restaurantName: cap.result.restaurantName ?? null, cuisine: cap.result.cuisine ?? null }
      : null,
    labScan: cap.labScan
      ? { scanModel: cap.labScan.scanModel, at: cap.labScan.at, itemCount: cap.labScan.menu.itemCount, hasVenue: !!cap.labScan.venue }
      : null,
    groundTruth: gtFor(cap),
    archived: isArchived(cap),
  }));
  const models = Object.entries(MODELS).map(([id, def]) => ({ id, label: def.label, provider: def.provider, price: def.price }));
  return c.json({ libraryDir: LIBRARY, captures, models });
});

// Podgląd PRAWDZIWYCH promptów (system + szablon treści użytkownika) per operacja.
app.get("/api/prompts", (c) => {
  const scanUser =
    contextText(
      { targetLang: "polski", restaurantHint: "{lokal? — opcjonalnie}", locationHint: "{Miasto, Kraj z GPS}", cuisineHint: "{kuchnia z peek? — opcjonalnie}" },
      3,
    ) + "\n\n[+ N zdjęć menu, każde z etykietą porządkową]";
  const describeUser =
    "Danie: {nazwa}\nKrótki opis z menu: {opis}\nRodzaj kuchni: {kuchnia}\nLokalizacja lokalu: {Miasto, Kraj}\n" +
    "Restauracja: {nazwa lokalu}\nJęzyk odpowiedzi: polski\n\nRozwiń informacje o tym daniu, trzymając się powyższego kontekstu.";
  return c.json({
    peek: { system: PEEK_SYSTEM, user: PEEK_INSTRUCTION + "\n\n[+ 1 zdjęcie menu]" },
    scan: { system: MENU_SYSTEM, user: scanUser },
    describe: { system: DESCRIBE_SYSTEM, user: describeUser, note: "bez obrazu (tekstowo)" },
    verify: {
      system: VERIFY_SYSTEM,
      user: verifyInstruction("{nazwa dania}", "{kuchnia}") + "\n\n[+ N zdjęć kandydatów, każde z etykietą porządkową]",
    },
    venuePhotos: {
      system: VENUE_SYSTEM,
      user: venueInstruction(["{danie 1}", "{danie 2}", "…"], "{kuchnia}") + "\n\n[+ zdjęcia Google Places i TripAdvisor, każde z etykietą i źródłem]",
    },
  });
});

app.get("/api/image", (c) => {
  const id = c.req.query("id");
  const n = Number(c.req.query("n") ?? "0");
  const cap = loadMeta().find((x) => x.id === id);
  const im = cap?.images[n];
  if (!im) return c.text("not found", 404);
  const buf = readFileSync(join(LIBRARY, im.file));
  return c.body(buf, 200, { "Content-Type": im.mediaType || "image/jpeg" });
});

app.post("/api/places-search", async (c) => {
  const { q, lat, lng } = await c.req.json<{ q: string; lat?: number; lng?: number }>();
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return c.json({ error: "Brak GOOGLE_MAPS_KEY w server/.env" }, 400);
  const body: Record<string, unknown> = { textQuery: q, languageCode: "pl", maxResultCount: 6 };
  if (lat != null && lng != null) body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 5000 } };
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { places?: any[] };
  return c.json({
    candidates: (j.places ?? []).map((p) => ({
      placeId: p.id,
      name: p.displayName?.text,
      address: p.formattedAddress,
      lat: p.location?.latitude,
      lng: p.location?.longitude,
    })),
  });
});

app.post("/api/archive", async (c) => {
  const { captureId, archived } = await c.req.json<{ captureId: string; archived: boolean }>();
  const cap = loadMeta().find((x) => x.id === captureId);
  const key = cap?.sig || captureId;
  let list = loadArchived();
  if (archived) list.push(key);
  else list = list.filter((k) => k !== key && k !== captureId);
  await saveArchived(list);
  return c.json({ ok: true });
});

// TRWAŁE usunięcie sampla z biblioteki (zdjęcia + metadane + ground-truth + wpis archiwum).
app.post("/api/delete", async (c) => {
  const { captureId } = await c.req.json<{ captureId: string }>();
  const caps = loadMeta();
  const cap = caps.find((x) => x.id === captureId);
  if (cap) {
    for (const im of cap.images ?? []) {
      try {
        const f = join(LIBRARY, im.file);
        if (existsSync(f)) unlinkSync(f);
      } catch {
        /* plik mógł zniknąć */
      }
    }
  }
  saveMeta(caps.filter((x) => x.id !== captureId));
  const key = cap?.sig || captureId;
  await saveArchived(loadArchived().filter((k) => k !== key && k !== captureId));
  const gt = loadGroundTruth();
  delete gt[key];
  delete gt[captureId];
  await saveGroundTruth(gt);
  return c.json({ ok: true });
});

// Import z FOLDERU lub pliku ZIP na dysku (ścieżka serwera).
app.post("/api/import-path", async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  if (!path?.trim()) return c.json({ error: "podaj ścieżkę folderu lub .zip" }, 400);
  try {
    const p = path.trim().replace(/^['"]|['"]$/g, "");
    const r = p.toLowerCase().endsWith(".zip") ? await ingestZip(readFileSync(p)) : await ingestFolder(p);
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// Import przez UPLOAD pliku ZIP (wybór pliku w przeglądarce).
app.post("/api/import-zip", async (c) => {
  try {
    const body = await c.req.parseBody();
    const f = body.file;
    if (!f || typeof f === "string") return c.json({ error: "brak pliku ZIP" }, 400);
    const buf = Buffer.from(await (f as File).arrayBuffer());
    const r = await ingestZip(buf);
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// ===== SAMPLE ONLINE: lab pobiera/importuje migawki z PRODUKCYJNEGO serwera =====================
// Lab (lokalny) sięga po sample do serwera produkcyjnego (tam apka je wysyła). Konfiguracja z env:
// LAB_PROD_URL (domyślnie Railway) + LAB_PROD_TOKEN/APP_TOKEN (x-app-token).
const PROD_URL = (process.env.LAB_PROD_URL || "https://menubutbetter-production.up.railway.app").replace(/\/+$/, "");
const PROD_TOKEN = process.env.LAB_PROD_TOKEN || process.env.APP_TOKEN || "";
async function prodFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${PROD_URL}${path}`, { ...init, headers: { ...(init?.headers ?? {}), "x-app-token": PROD_TOKEN } });
}

app.get("/api/server-samples", async (c) => {
  try {
    const r = await prodFetch("/samples?pending=1");
    const d = (await r.json()) as { enabled?: boolean; samples?: unknown[] };
    return c.json({ prodUrl: PROD_URL, configured: !!PROD_TOKEN, ...d });
  } catch (e) {
    return c.json({ error: `Nie połączono z serwerem (${PROD_URL}): ${(e as Error).message}`, prodUrl: PROD_URL }, 502);
  }
});

app.post("/api/server-samples/import", async (c) => {
  const { id } = await c.req.json<{ id: number }>();
  if (!id) return c.json({ error: "brak id" }, 400);
  try {
    const zr = await prodFetch(`/samples/${id}/zip`);
    if (!zr.ok) return c.json({ error: `pobranie zip: HTTP ${zr.status}` }, 502);
    const buf = Buffer.from(await zr.arrayBuffer());
    const res = await ingestZip(buf); // import do lokalnej biblioteki (dedup)
    await prodFetch(`/samples/${id}/imported`, { method: "POST" }).catch(() => {}); // oznacz + skasuj zip na serwerze
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.get("/api/client-errors", async (c) => {
  try {
    const r = await prodFetch("/client-errors?limit=300");
    const d = (await r.json()) as { errors?: unknown[] };
    return c.json({ prodUrl: PROD_URL, configured: !!PROD_TOKEN, errors: d.errors ?? [] });
  } catch (e) {
    return c.json({ error: `Nie połączono z serwerem (${PROD_URL}): ${(e as Error).message}`, prodUrl: PROD_URL }, 502);
  }
});

// Zamykanie/archiwizowanie bugów (po sygnaturze message+label) — stan lokalny w labie.
const ERR_CLOSED_FILE = join(HERE, "error-closed.json");
function loadClosedSigs(): string[] {
  try { return JSON.parse(readFileSync(ERR_CLOSED_FILE, "utf8")); } catch { return []; }
}
function saveClosedSigs(s: string[]): void {
  writeFileSync(ERR_CLOSED_FILE, JSON.stringify([...new Set(s)], null, 2));
}
app.get("/api/error-closed", (c) => c.json({ closed: loadClosedSigs() }));
app.post("/api/error-closed", async (c) => {
  const { sig, closed } = await c.req.json<{ sig: string; closed: boolean }>();
  if (!sig) return c.json({ error: "brak sig" }, 400);
  let list = loadClosedSigs();
  if (closed) list.push(sig);
  else list = list.filter((x) => x !== sig);
  saveClosedSigs(list);
  return c.json({ ok: true });
});

app.get("/api/install-activity", async (c) => {
  const installId = c.req.query("installId") || "";
  try {
    const r = await prodFetch(`/install-activity?installId=${encodeURIComponent(installId)}&limit=200`);
    const d = (await r.json()) as { activity?: unknown[] };
    return c.json({ activity: d.activity ?? [] });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

app.get("/api/installs", async (c) => {
  try {
    const r = await prodFetch("/installs");
    const d = (await r.json()) as { installs?: unknown[] };
    return c.json({ prodUrl: PROD_URL, configured: !!PROD_TOKEN, installs: d.installs ?? [] });
  } catch (e) {
    return c.json({ error: `Nie połączono z serwerem (${PROD_URL}): ${(e as Error).message}`, prodUrl: PROD_URL }, 502);
  }
});
app.post("/api/install-name", async (c) => {
  const b = await c.req.json<{ installId: string; name: string }>();
  try {
    await prodFetch("/install/name", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

app.post("/api/server-samples/delete", async (c) => {
  const { id } = await c.req.json<{ id: number }>();
  if (!id) return c.json({ error: "brak id" }, 400);
  try {
    await prodFetch(`/samples/${id}`, { method: "DELETE" });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.post("/api/annotate", async (c) => {
  const { captureId, groundTruth } = await c.req.json<{ captureId: string; groundTruth: GroundTruth | null }>();
  const cap = loadMeta().find((x) => x.id === captureId);
  const key = cap?.sig || captureId; // po sygnaturze (stabilnej); fallback id
  const store = loadGroundTruth();
  if (groundTruth) store[key] = { ...groundTruth, id: captureId, capturedAt: cap?.createdAt };
  else {
    delete store[key];
    delete store[captureId]; // sprzątnij też ewentualny stary wpis po id
  }
  await saveGroundTruth(store);
  return c.json({ ok: true });
});

// --- Symulacja aplikacji: TEN SAM kod co w apce (skan → lokal → zdjęcia per pozycja) ------
// Cel: wziąć sampla, odczytać menu (extractMenu) i dla wybranej pozycji zobaczyć KROK PO KROKU,
// co zwraca tor zdjęć (runDishPhotos: tier 1 strona lokalu/portale → vision → tier 2 web → tier 3
// poglądowe), z ocenami i flagą fromVenue — żeby ocenić, czemu coś jest „z lokalu".

// 1) Skan menu — jak w apce: najpierw peek (kuchnia→cuisineHint), potem scan; opcjonalnie lokal.
app.post("/api/sim-scan", async (c) => {
  const { captureId, scanModel, enrichModel, peekModel, withVenue, withPeek, forceRescan, useCache } = await c.req.json<{
    captureId: string; scanModel?: ModelId; enrichModel?: ModelId; peekModel?: ModelId; withVenue?: boolean; withPeek?: boolean; forceRescan?: boolean; useCache?: boolean;
  }>();
  const cap = loadMeta().find((x) => x.id === captureId);
  if (!cap) return c.json({ error: "nie ma migawki" }, 404);
  // CACHE: jeśli jest zapisany skan i nie wymuszono ponownego — zwróć natychmiast (testy zdjęć
  // nie skanują od nowa). „Skanuj na nowo" ustawia forceRescan i nadpisuje zapis.
  if (!forceRescan && cap.labScan) {
    return c.json({ ms: 0, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 }, cached: true, ...cap.labScan });
  }
  try {
  const images = allImageInputs(cap);
  if (!images.length) return c.json({ error: "brak zdjęć" }, 400);
  const model = (scanModel && scanModel in MODELS ? scanModel : DEFAULT_MODEL) as ModelId;
  const t0 = Date.now();
  const costBefore = providerTotals(); // do logu kosztów (peek + scan + namierzenie lokalu)
  const modelBefore = modelTotals();
  const cacheBefore = cacheHitsSnapshot().total;
  // Peek (jak w apce) — z pierwszego zdjęcia; jego kuchnia trafia jako cuisineHint do skanu.
  let peek: any = null;
  if (withPeek !== false) {
    const pm = (peekModel && peekModel in MODELS ? peekModel : DEFAULT_MODEL) as ModelId;
    const img0 = imageInput(cap, 0);
    if (img0) {
      const r = await quickPeek(img0, pm).catch(() => null);
      if (r) peek = { model: pm, isMenu: r.result.isMenu, cuisine: r.result.cuisine, restaurantName: r.result.restaurantName, cost: r.usage.costUsd };
    }
  }
  const emodel = (enrichModel && enrichModel in MODELS ? enrichModel : model) as ModelId;
  const { menu, usage } = await extractMenu(images, {
    targetLang: "polski",
    locationHint: cap.locationHint,
    cuisineHint: peek?.cuisine || undefined,
    model,
    enrichModel: emodel,
    noCache: !useCache, // domyślnie świeży (lab ma własny labScan); „🗄 użyj cache" włącza cache serwera
  });
  const items = (menu.sections ?? []).flatMap((s: any) =>
    (s.items ?? []).map((it: any) => ({
      section: s.name,
      original: it.original,
      translated: it.translated,
      photoQuery: it.photo_query,
      photoQueryLocal: it.photo_query_local,
      branded: it.branded,
      description: it.description,
    })),
  );
  let venue: any = null;
  if (withVenue && menu.restaurant_name) {
    const rest = await findRestaurant({ name: menu.restaurant_name, lat: cap.location?.lat, lng: cap.location?.lng }).catch(() => null);
    if (rest) {
      const ta = await findTripAdvisor({ name: rest.name, lat: rest.location?.lat, lng: rest.location?.lng }).catch(() => null);
      venue = {
        name: rest.name,
        address: rest.address,
        website: rest.website,
        placeId: rest.placeId,
        location: rest.location,
        city: rest.city, // do zawężenia zapytań portalowych
        nameVerified: rest.nameVerified, // czy Places trafił w nazwę (Tier 0: pewność lokalu)
        photoNames: rest.photoNames ?? [],
        taPhotos: (ta?.photos ?? []).map((p) => ({ url: p.url, caption: p.caption })),
        taUrl: ta?.url ?? null,
        taLocationId: ta?.locationId ?? null, // pewny werdykt „z lokalu" dla TripAdvisora
      };
    }
  }
  // Zapisz skan przy samplu (najlepsza wersja) — przeżywa restart, testy zdjęć biorą go natychmiast.
  const labScan: LabScan = {
    scanModel: model,
    at: Date.now(),
    peek,
    menu: { restaurantName: menu.restaurant_name, cuisine: menu.cuisine, itemCount: items.length },
    items,
    venue,
  };
  const all = loadMeta();
  const idx = all.findIndex((x) => x.id === captureId);
  if (idx >= 0) {
    all[idx]!.labScan = labScan;
    saveMeta(all);
  }
  recordCostDelta("sim-scan", { model, enrichModel: emodel, captureId, withVenue: !!withVenue }, costBefore, t0, cacheBefore, modelBefore);
  return c.json({ ms: Date.now() - t0, usage, cached: false, ...labScan });
  } catch (e) {
    console.error("sim-scan error:", e);
    return c.json({ error: `skan nie powiódł się: ${(e as Error).message}` }, 502);
  }
});

// Usuń zapisany skan sampla (gdy chcesz wymusić świeży przy kolejnym teście).
app.post("/api/sim-scan-clear", async (c) => {
  const { captureId } = await c.req.json<{ captureId: string }>();
  const all = loadMeta();
  const idx = all.findIndex((x) => x.id === captureId);
  if (idx >= 0) {
    delete all[idx]!.labScan;
    saveMeta(all);
  }
  return c.json({ ok: true });
});

// 1b) Opis dania (rola „describe") — jak /dish-info w apce.
app.post("/api/sim-describe", async (c) => {
  const b = await c.req.json<{ dish: string; description?: string; cuisine?: string; location?: string; restaurant?: string; model?: ModelId; captureId?: string }>();
  if (!b.dish?.trim()) return c.json({ error: "brak nazwy dania" }, 400);
  try {
    const t0 = Date.now();
    const { text, usage } = await withCostLog("sim-describe", { dish: b.dish, model: b.model, lokal: b.restaurant, captureId: b.captureId }, () =>
      describeDish({
        name: b.dish,
        description: b.description,
        cuisine: b.cuisine,
        location: b.location,
        restaurant: b.restaurant,
        targetLang: "polski",
        model: (b.model && b.model in MODELS ? b.model : DEFAULT_MODEL) as ModelId,
      }),
    );
    return c.json({ ms: Date.now() - t0, text, usage });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 2) Zdjęcia dla JEDNEJ pozycji — DOKŁADNIE runDishPhotos z apki, z pełnym śladem debug.
app.post("/api/sim-dish", async (c) => {
  const b = await c.req.json<{
    dish: string;
    photoQuery?: string;
    photoQueryLocal?: string;
    cuisine?: string;
    restaurantName?: string;
    city?: string;
    taLocationId?: string;
    branded?: boolean;
    website?: string;
    verifyModel?: string;
    num?: number;
    verify?: boolean;
    captureId?: string;
    useCache?: boolean; // domyślnie LAB OMIJA cache (uczciwy koszt); toggle „użyj cache (jak apka)"
  }>();
  if (!b.dish?.trim()) return c.json({ error: "brak nazwy dania" }, 400);
  try {
    const { photos, usage, debug } = await withCostLog("sim-dish", { dish: b.dish, model: b.verifyModel || "claude-sonnet-4-6", lokal: b.restaurantName, captureId: b.captureId, useCache: !!b.useCache }, () =>
    runDishPhotos({
      dish: b.dish,
      photoQuery: b.photoQuery,
      photoQueryLocal: b.photoQueryLocal,
      restaurantHint: b.restaurantName, // w apce hint ≈ nazwa lokalu (bias zapytań portalowych)
      restaurantName: b.restaurantName,
      city: b.city,
      taLocationId: b.taLocationId,
      branded: b.branded,
      cuisine: b.cuisine,
      website: b.website,
      num: b.num ?? 4,
      verify: b.verify !== false,
      verifyModel: b.verifyModel,
      noCache: !b.useCache, // bez toggla LAB nie korzysta z cache (i nie zafałszowuje kosztu modelu)
    }));
    return c.json({ photos, usage, debug });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 3) Tier 0 — dopasowanie puli zdjęć lokalu (Google Places + TripAdvisor) do dań.
app.post("/api/sim-venue", async (c) => {
  const b = await c.req.json<{ dishes: string[]; cuisine?: string; photoNames?: string[]; taPhotos?: { url: string; caption: string | null }[]; model?: string; certain?: boolean; captureId?: string; restaurantName?: string }>();
  const t0 = Date.now();
  try {
    const { matches, usage } = await withCostLog("sim-venue", { model: b.model, dishes: (b.dishes ?? []).length, lokal: b.restaurantName, captureId: b.captureId }, () =>
      matchVenuePhotos({
        photoNames: b.photoNames ?? [],
        taPhotos: b.taPhotos ?? [],
        dishes: b.dishes ?? [],
        cuisine: b.cuisine,
        model: b.model,
        certain: b.certain !== false,
      }),
    );
    return c.json({ ms: Date.now() - t0, usage, pool: (b.photoNames?.length ?? 0) + (b.taPhotos?.length ?? 0), matches });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// --- KOSZTY: log operacji (z rozbiciem) + statystyki łączne (okres) ------------------------
app.get("/api/cost-log", (c) => {
  const period = c.req.query("period") || "all";
  const now = Date.now();
  const cutoff = period === "today" ? now - 24 * 3600e3 : period === "7d" ? now - 7 * 24 * 3600e3 : period === "30d" ? now - 30 * 24 * 3600e3 : 0;
  const egress = otherRate("egress");
  // PRZELICZENIE z AKTUALNEGO cennika (override > MODELS) — zmiana ceny przelicza całą historię.
  const ovAll = loadPriceOverrides();
  const AI_PROV = new Set(["claude", "openai", "google"]);
  const PER_CALL = new Set(["google_places", "serper", "serpapi"]);
  const rate = (model: string) => { const ov = ovAll[model]; const def = (MODELS as Record<string, { price: { in: number; out: number } }>)[model]; return { in: ov?.in ?? def?.price.in ?? 0, out: ov?.out ?? def?.price.out ?? 0 }; };
  const tokCostOf = (models?: ModelDelta[]) => (models ?? []).reduce((n, m) => { const r = rate(m.model); return n + (m.inTok / 1e6) * r.in + (m.outTok / 1e6) * r.out; }, 0);
  const apiCostOf = (delta: CostDelta[]) => delta.reduce((n, d) => n + (PER_CALL.has(d.provider) ? (d.calls / 1000) * otherRate(d.provider) : 0), 0);
  const provCost = (e: CostEntry, d: CostDelta) => AI_PROV.has(d.provider)
    ? (e.models ?? []).filter((m) => apiTag(m.model) === d.provider).reduce((n, m) => { const r = rate(m.model); return n + (m.inTok / 1e6) * r.in + (m.outTok / 1e6) * r.out; }, 0)
    : (PER_CALL.has(d.provider) ? (d.calls / 1000) * otherRate(d.provider) : 0);
  const sumD = (e: CostEntry, f: keyof CostDelta) => e.delta.reduce((n, d) => n + (d[f] as number), 0);
  const enrich = (e: CostEntry) => {
    const bytesSent = sumD(e, "bytesSent");
    const bytesRecv = sumD(e, "bytesRecv");
    const tokenCost = e.models ? tokCostOf(e.models) : sumD(e, "costUsd"); // stare wpisy: fallback
    const apiCost = apiCostOf(e.delta);
    const dataCost = (bytesSent / 1e9) * egress;
    const inTok = e.models ? e.models.reduce((n, m) => n + m.inTok, 0) : sumD(e, "inTok");
    const outTok = e.models ? e.models.reduce((n, m) => n + m.outTok, 0) : sumD(e, "outTok");
    return { ...e, tokenCost, apiCost, bytesSent, bytesRecv, inTok, outTok, calls: sumD(e, "calls"), dataCost, totalCost: tokenCost + apiCost + dataCost };
  };
  const entries = readCostLog().filter((e) => e.ts >= cutoff).map(enrich).reverse();
  const agg = entries.reduce(
    (a, e) => ({
      count: a.count + 1, calls: a.calls + e.calls, inTok: a.inTok + e.inTok, outTok: a.outTok + e.outTok,
      tokenCost: a.tokenCost + e.tokenCost, apiCost: a.apiCost + e.apiCost, bytesSent: a.bytesSent + e.bytesSent, bytesRecv: a.bytesRecv + e.bytesRecv,
      dataCost: a.dataCost + e.dataCost, totalCost: a.totalCost + e.totalCost,
    }),
    { count: 0, calls: 0, inTok: 0, outTok: 0, tokenCost: 0, apiCost: 0, bytesSent: 0, bytesRecv: 0, dataCost: 0, totalCost: 0 },
  );
  // OSZCZĘDNOŚCI z cache: dla operacji z trafieniem szacujemy zaoszczędzone $ jako (średni koszt
  // MISS tej operacji − jej obecny koszt) i tokeny jako średnie z miss. Wszystko z aktualnego cennika.
  const missByOp: Record<string, { n: number; cost: number; inTok: number; outTok: number }> = {};
  for (const e of entries) if (!e.cacheHits) { const m = (missByOp[e.op] = missByOp[e.op] || { n: 0, cost: 0, inTok: 0, outTok: 0 }); m.n++; m.cost += e.totalCost; m.inTok += e.inTok; m.outTok += e.outTok; }
  const savings = { count: 0, cost: 0, inTok: 0, outTok: 0 };
  for (const e of entries) if (e.cacheHits) {
    const m = missByOp[e.op]; if (!m || !m.n) continue;
    savings.count += e.cacheHits;
    savings.cost += Math.max(0, m.cost / m.n - e.totalCost);
    savings.inTok += m.inTok / m.n; savings.outTok += m.outTok / m.n;
  }
  // GRUPOWANIE per menu: skan + wszystkie dalsze operacje na tym samym samplu (captureId),
  // a gdy brak captureId — po nazwie lokalu. Każda grupa: suma + rozbicie per provider + operacje.
  const meta = loadMeta();
  const capName = (id?: string): string => {
    const cap = meta.find((x) => x.id === id);
    return (cap?.labScan?.menu?.restaurantName as string) || cap?.result?.restaurantName || ("sample " + (id ?? "").slice(0, 8));
  };
  const groupOf = (e: (typeof entries)[number]): { key: string; label: string } => {
    const cid = e.meta?.captureId as string | undefined;
    if (cid) return { key: "c:" + cid, label: capName(cid) };
    const lok = e.meta?.lokal as string | undefined;
    if (lok) return { key: "r:" + lok.toLowerCase(), label: lok };
    return { key: "—", label: "Inne (niepowiązane z menu)" };
  };
  type Prov = { provider: string; calls: number; inTok: number; outTok: number; costUsd: number; bytesSent: number; bytesRecv: number };
  const gmap: Record<string, { key: string; label: string; totalCost: number; tokenCost: number; apiCost: number; dataCost: number; count: number; cacheHits: number; bytesSent: number; bytesRecv: number; ts: number; byProvider: Record<string, Prov>; entries: typeof entries }> = {};
  for (const e of entries) {
    const { key, label } = groupOf(e);
    const g = (gmap[key] = gmap[key] || { key, label, totalCost: 0, tokenCost: 0, apiCost: 0, dataCost: 0, count: 0, cacheHits: 0, bytesSent: 0, bytesRecv: 0, ts: 0, byProvider: {}, entries: [] });
    g.totalCost += e.totalCost;
    g.tokenCost += e.tokenCost;
    g.apiCost += e.apiCost;
    g.dataCost += e.dataCost;
    g.bytesSent += e.bytesSent;
    g.bytesRecv += e.bytesRecv;
    g.cacheHits += e.cacheHits || 0;
    g.count++;
    g.ts = Math.max(g.ts, e.ts);
    for (const d of e.delta) {
      const p = (g.byProvider[d.provider] = g.byProvider[d.provider] || { provider: d.provider, calls: 0, inTok: 0, outTok: 0, costUsd: 0, bytesSent: 0, bytesRecv: 0 });
      p.calls += d.calls; p.inTok += d.inTok; p.outTok += d.outTok; p.costUsd += provCost(e, d); p.bytesSent += d.bytesSent; p.bytesRecv += d.bytesRecv;
    }
    g.entries.push(e);
  }
  const groups = Object.values(gmap)
    .map((g) => ({ ...g, byProvider: Object.values(g.byProvider).sort((a, b) => b.costUsd + b.bytesSent / 1e9 * egress - (a.costUsd + a.bytesSent / 1e9 * egress)) }))
    .sort((a, b) => b.ts - a.ts);
  return c.json({ period, egressUsdPerGB: egress, agg, savings, groups });
});

app.post("/api/cost-log-clear", (c) => {
  try {
    if (existsSync(COSTLOG_FILE)) unlinkSync(COSTLOG_FILE);
  } catch {
    /* brak */
  }
  return c.json({ ok: true });
});

// --- CACHE treści: statystyki (ile wpisów/trafień per rodzaj) + czyszczenie. -----------------
app.get("/api/cache-stats", async (c) => {
  const stats = await cacheStats();
  return c.json({ ...stats, sessionHits: cacheHitsSnapshot() });
});
app.get("/api/cache-browse", async (c) => {
  const kind = c.req.query("kind") || undefined;
  const q = c.req.query("q") || undefined;
  const limit = Number(c.req.query("limit")) || 100;
  return c.json(await cacheBrowse({ kind, q, limit }));
});
app.get("/api/cache-size", async (c) => {
  const sz = await cacheSize();
  const rate = otherRate("storage"); // $/GB-mies.
  return c.json({ ...sz, storageUsdPerGbMonth: rate, storageCostMonthly: (sz.bytes / 1e9) * rate });
});
app.post("/api/cache-clear", async (c) => {
  const b = await c.req.json<{ kind?: string }>().catch(() => ({}) as { kind?: string });
  await cacheClear(b.kind as CacheKind | undefined);
  return c.json({ ok: true });
});

// --- CENY: lista wszystkich (modele + inne API + transfer) ze źródłami + ręczna podmiana ----
app.get("/api/prices", (c) => {
  const ov = loadPriceOverrides();
  const models = Object.entries(MODELS).map(([id, def]) => {
    const o = ov[id] ?? {};
    return {
      id,
      label: def.label,
      provider: def.provider,
      in: o.in ?? def.price.in,
      out: o.out ?? def.price.out,
      baseIn: def.price.in,
      baseOut: def.price.out,
      overridden: o.in != null || o.out != null,
      source: PRICE_SOURCES[apiTag(id)] ?? null,
    };
  });
  const others = OTHER_PRICES_DEFAULT.map((p) => ({ ...p, value: ov[p.key]?.value ?? p.value, base: p.value, overridden: ov[p.key]?.value != null }));
  return c.json({ models, others });
});

// Ręczna podmiana ceny (model: in/out; inne: value). reset=true → przywróć domyślną.
app.post("/api/prices", async (c) => {
  const b = await c.req.json<{ key: string; in?: number; out?: number; value?: number; reset?: boolean }>();
  if (!b.key) return c.json({ error: "brak key" }, 400);
  const ov = loadPriceOverrides();
  if (b.reset) delete ov[b.key];
  else {
    ov[b.key] = ov[b.key] ?? {};
    if (b.in != null) ov[b.key]!.in = b.in;
    if (b.out != null) ov[b.key]!.out = b.out;
    if (b.value != null) ov[b.key]!.value = b.value;
  }
  savePriceOverrides(ov);
  return c.json({ ok: true });
});

// --- Zadania: długie eksperymenty w TLE (postęp / pauza / wznowienie / przerwanie) --------
type JobState = "running" | "paused" | "canceled" | "done";
interface Job {
  exp: any; // eksperyment (config + results) — mutowany w trakcie
  total: number;
  done: number;
  current: string;
  control: "run" | "pause" | "cancel";
  state: JobState;
}
const jobs = new Map<string, Job>();
function runFile(id: string): string {
  return join(RESULTS_DIR, `run-${id.replace(/^run-/, "")}.json`);
}
function persistJob(job: Job): void {
  job.exp.progress = { state: job.state, done: job.done, total: job.total, current: job.current, at: Date.now() };
  writeFileSync(runFile(job.exp.id), JSON.stringify(job.exp, null, 2));
}
function countDone(exp: any): number {
  let n = 0;
  for (const cap of exp.results)
    for (const model of exp.config.models) {
      const m = cap.byModel[model] || {};
      for (const op of exp.config.operations) if (m[op]) n++;
    }
  return n;
}

async function runJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  const exp = job.exp;
  const meta = loadMeta();
  for (const capStub of exp.results) {
    const cap = meta.find((x) => x.id === capStub.captureId);
    if (!cap) continue;
    const gtc = gtFor(cap);
    for (const model of exp.config.models as ModelId[]) {
      capStub.byModel[model] = capStub.byModel[model] || {};
      const m = capStub.byModel[model];
      for (const op of exp.config.operations as string[]) {
        if (m[op]) continue; // wznowienie: pomiń już zrobione
        if (job.control === "cancel") {
          job.state = "canceled";
          persistJob(job);
          return;
        }
        if (job.control === "pause") {
          job.state = "paused";
          persistJob(job);
          return;
        }
        job.current = `${cap.name || cap.id} · ${model} · ${op}`;
        try {
          if (op === "peek") m.peek = await opPeek(cap, model);
          else if (op === "scan") m.scan = await opScan(cap, model, !!exp.config.withVenue, gtc ?? undefined);
          else if (op === "describe") m.describe = await opDescribe(cap, model);
          else if (op === "verify") m.verify = await opVerify(cap, model);
          else if (op === "venuePhotos") m.venuePhotos = await opVenuePhotos(cap, model);
        } catch (e) {
          m[op] = { ok: false, error: (e as Error).message };
        }
        job.done++;
      }
    }
    persistJob(job); // zapis po każdej restauracji (do wznowienia po crashu/restarcie)
  }
  job.state = "done";
  job.current = "ukończono";
  persistJob(job);
}

app.post("/api/run", async (c) => {
  const { captureIds, models, operations, withVenue, name } = await c.req.json<{
    captureIds: string[];
    models: ModelId[];
    operations: ("peek" | "scan" | "describe" | "verify" | "venuePhotos")[];
    withVenue?: boolean;
    name?: string;
  }>();
  const meta = loadMeta();
  const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const results = captureIds
    .map((cid) => meta.find((x) => x.id === cid))
    .filter((c): c is MetaCapture => !!c)
    .map((cap) => ({ captureId: cap.id, locationHint: cap.locationHint, groundTruth: gtFor(cap), byModel: {} as any }));
  const exp = {
    id,
    at: Date.now(),
    name: name?.trim() || null,
    libraryDir: LIBRARY,
    config: { models, operations, withVenue: !!withVenue },
    captureIds,
    results,
    judgments: null as unknown,
    judgeModel: null as unknown,
  };
  const total = results.length * models.length * operations.length;
  const job: Job = { exp, total, done: 0, current: "start", control: "run", state: "running" };
  jobs.set(id, job);
  persistJob(job);
  void runJob(id); // w TLE — nie czekamy
  return c.json({ runId: id, total });
});

// Postęp na żywo (polling co ~1s).
app.get("/api/run-status", (c) => {
  const id = c.req.query("id") || "";
  const job = jobs.get(id);
  if (job)
    return c.json({ state: job.state, done: job.done, total: job.total, current: job.current, results: job.exp.results });
  const f = runFile(id);
  if (existsSync(f)) {
    const e = JSON.parse(readFileSync(f, "utf8"));
    const p = e.progress || {};
    return c.json({ state: p.state || "done", done: p.done ?? countDone(e), total: p.total ?? 0, current: p.current || "", results: e.results });
  }
  return c.json({ error: "nie ma takiego zadania" }, 404);
});

// Pauza / przerwanie biegnącego zadania.
app.post("/api/run-control", async (c) => {
  const { id, action } = await c.req.json<{ id: string; action: "pause" | "cancel" }>();
  const job = jobs.get(id);
  if (!job) return c.json({ error: "zadanie nieaktywne (serwer zrestartowany?) — użyj Wznów" }, 404);
  job.control = action === "cancel" ? "cancel" : "pause";
  return c.json({ ok: true });
});

// Wznowienie (też po restarcie serwera — czyta plik, dorabia brakujące jednostki).
app.post("/api/run-resume", async (c) => {
  const { id } = await c.req.json<{ id: string }>();
  const f = runFile(id);
  if (!existsSync(f)) return c.json({ error: "nie ma eksperymentu" }, 404);
  const exp = JSON.parse(readFileSync(f, "utf8"));
  const total = exp.results.length * exp.config.models.length * exp.config.operations.length;
  const job: Job = { exp, total, done: countDone(exp), current: "wznowiono", control: "run", state: "running" };
  jobs.set(id, job);
  persistJob(job);
  void runJob(id);
  return c.json({ runId: id, total, done: job.done });
});

// Lista zapisanych eksperymentów (do powrotu/analizy/powtórzenia).
app.get("/api/runs", (c) => {
  let files: string[] = [];
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.startsWith("run-") && f.endsWith(".json"));
  } catch {
    /* brak */
  }
  const runs = files
    .map((f) => {
      try {
        const e = JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8"));
        return {
          id: e.id ?? f.replace(/\.json$/, ""),
          at: e.at ?? null,
          name: e.name ?? null,
          models: e.config?.models ?? e.models ?? [],
          operations: e.config?.operations ?? e.operations ?? [],
          withVenue: e.config?.withVenue ?? e.withVenue ?? false,
          captures: (e.captureIds ?? e.results ?? []).length,
          judged: !!e.judgments,
          state: e.progress?.state ?? "done",
          done: e.progress?.done ?? null,
          total: e.progress?.total ?? null,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => (b.at ?? 0) - (a.at ?? 0));
  return c.json({ runs });
});

// Pełny zapisany eksperyment (config + wyniki + werdykty) — do wczytania w UI.
app.get("/api/run-get", (c) => {
  const id = c.req.query("id");
  const file = join(RESULTS_DIR, `run-${(id ?? "").replace(/^run-/, "")}.json`);
  if (!existsSync(file)) return c.json({ error: "nie ma takiego eksperymentu" }, 404);
  return c.json(JSON.parse(readFileSync(file, "utf8")));
});

app.post("/api/judge", async (c) => {
  const { results, judgeModel, runId, deep } = await c.req.json<{
    results: any[];
    judgeModel?: string;
    runId?: string;
    deep?: boolean;
  }>();
  // Domyślnie NAJMOCNIEJSZY sędzia (Opus). Można wybrać dowolny topowy model.
  const model = judgeModel && judgeModel in MODELS ? judgeModel : "claude-opus-4-8";
  const judgments: any[] = [];
  for (const cap of results) {
    const capMeta = loadMeta().find((x) => x.id === cap.captureId);
    if (!capMeta) continue;
    const scanByModel: Record<string, any> = {};
    const describeByModel: Record<string, any> = {};
    for (const [mid, m] of Object.entries<any>(cap.byModel)) {
      if (m.scan?.ok) scanByModel[mid] = m.scan;
      if (m.describe?.ok) describeByModel[mid] = m.describe;
    }
    const j: any = { captureId: cap.captureId };
    try {
      if (Object.keys(scanByModel).length) j.scan = await judgeScan(capMeta, scanByModel, model, !!deep);
      if (Object.keys(describeByModel).length) j.describe = await judgeDescribe(capMeta, describeByModel, model, !!deep);
    } catch (e) {
      j.error = (e as Error).message;
    }
    if (j.scan || j.describe || j.error) judgments.push(j);
  }
  // Dopisz werdykty do pliku eksperymentu (trwałe — można wrócić i analizować).
  if (runId) {
    const file = join(RESULTS_DIR, `run-${runId.replace(/^run-/, "")}.json`);
    if (existsSync(file)) {
      try {
        const e = JSON.parse(readFileSync(file, "utf8"));
        e.judgments = judgments;
        e.judgeModel = model;
        e.judgeDeep = !!deep;
        await writeFile(file, JSON.stringify(e, null, 2));
      } catch {
        /* nie blokuj */
      }
    }
  }
  return c.json({ judgeModel: model, deep: !!deep, judgments });
});

// Jednorazowa migracja: gdy biblioteka pusta, wciągnij istniejące eksporty z samples/captures/*.
async function migrateSamplesIfEmpty(): Promise<void> {
  ensureLibrary();
  if (loadMeta().length > 0) return;
  try {
    const dirs = readdirSync(SAMPLES, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("mbb-captures"));
    for (const d of dirs) {
      try {
        const r = await ingestFolder(join(SAMPLES, d.name));
        console.log(`[lab] migracja ${d.name}: +${r.added} (pominięto ${r.skipped})`);
      } catch (e) {
        console.log(`[lab] migracja ${d.name} nieudana: ${(e as Error).message}`);
      }
    }
  } catch {
    /* brak starych sampli */
  }
}

await migrateSamplesIfEmpty();

const PORT = Number(process.env.LAB_PORT ?? 8799);
void initCache(); // cache treści (L1 w pamięci; L2 Postgres gdy DATABASE_URL) — do testów cache w labie
serve({ fetch: app.fetch, port: PORT });
console.log(`\n🔬 LAB modeli: http://localhost:${PORT}`);
console.log(`   biblioteka: ${LIBRARY} (${loadMeta().length} migawek)\n`);
