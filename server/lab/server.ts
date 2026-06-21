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
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
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

// Katalog ZEWNĘTRZNYCH SERWISÓW, z których korzysta apka (nie tylko API modeli — też infra, build, dane).
// `price` = orientacyjnie (wg wiedzy; zweryfikuj klikając „cennik ↗" lub „zaciągnij"). dashboard = panel/logowanie.
const SERVICES: { key: string; name: string; icon: string; category: string; desc: string; dashboard: string; pricing: string; price: string }[] = [
  // ── AI (modele) ──
  { key: "anthropic", name: "Anthropic (Claude)", icon: "🧠", category: "AI (modele)",
    desc: "Rdzeń aplikacji: vision — odczyt struktury menu ze zdjęć (Faza A) + enrich — tłumaczenia/opisy dań (Faza B). Modele Sonnet / Opus / Haiku.",
    dashboard: "https://console.anthropic.com", pricing: PRICE_SOURCES.claude!,
    price: "za MTok (in/out): Sonnet $3/$15 · Opus $5/$25 · Haiku $1/$5" },
  { key: "openai", name: "OpenAI (GPT-5)", icon: "🤖", category: "AI (modele)",
    desc: "Alternatywne modele do skanu/enrichu (porównania jakości i kosztu). GPT-5 / mini / nano.",
    dashboard: "https://platform.openai.com", pricing: PRICE_SOURCES.openai!,
    price: "za MTok (in/out): GPT-5 $1.25/$10 · mini $0.25/$2 · nano $0.05/$0.40" },
  { key: "gemini", name: "Google Gemini", icon: "✨", category: "AI (modele)",
    desc: "Tanie alternatywne modele (Gemini 2.5 Flash / Pro) do skanu i enrichu.",
    dashboard: "https://aistudio.google.com/apikey", pricing: PRICE_SOURCES.google!,
    price: "za MTok (in/out): Flash-Lite $0.10/$0.40 · Flash $0.30/$2.50 · Pro $1.25/$10" },
  // ── API danych ──
  { key: "google_places", name: "Google Places API", icon: "📍", category: "API danych",
    desc: "Namierzanie lokalu po nazwie/GPS: adres, oceny, godziny + zdjęcia „z lokalu” z Google.",
    dashboard: "https://console.cloud.google.com/google/maps-apis", pricing: PRICE_SOURCES.google_places!,
    price: "~$17–32 / 1000 zapytań (zależnie od pól). Darmowy kredyt $200/mc jest wycofywany." },
  { key: "google_cse", name: "Google Custom Search (CSE)", icon: "🔎", category: "API danych",
    desc: "Wyszukiwanie zdjęć dań w sieci (fallback, gdy Serper nic nie zwróci).",
    dashboard: "https://programmablesearchengine.google.com/controlpanel/all", pricing: "https://developers.google.com/custom-search/v1/overview#pricing",
    price: "100 zapytań/dzień gratis, potem $5 / 1000 (limit 10k/dzień)" },
  { key: "serper", name: "Serper.dev", icon: "🖼️", category: "API danych",
    desc: "Główne tanie źródło zdjęć POGLĄDOWYCH dań (Google Images przez SERP).",
    dashboard: "https://serper.dev/dashboard", pricing: PRICE_SOURCES.serper!,
    price: "~$0.30–1 / 1000 zapytań (zależnie od planu); 2500 zapytań gratis na start" },
  { key: "serpapi", name: "SerpApi", icon: "🔁", category: "API danych",
    desc: "Alternatywne wyszukiwanie SERP — zapas dla Serpera.",
    dashboard: "https://serpapi.com/dashboard", pricing: PRICE_SOURCES.serpapi!,
    price: "od $75/mc (5k zapytań); 100 zapytań/mc gratis" },
  { key: "tripadvisor", name: "TripAdvisor Content API", icon: "🦉", category: "API danych",
    desc: "Weryfikacja lokalu + zdjęcia „z lokalu” (pewne ID + czyste portale) w torze zdjęć.",
    dashboard: "https://www.tripadvisor.com/developers", pricing: PRICE_SOURCES.tripadvisor!,
    price: "5000 zapytań/mc gratis, potem ~$0.001–0.01 / zapytanie" },
  { key: "wikimedia", name: "Wikimedia Commons", icon: "📚", category: "API danych",
    desc: "Darmowe zdjęcia dań (CC / public domain) — bezkosztowe źródło poglądowe. Bez klucza (tylko User-Agent).",
    dashboard: "https://commons.wikimedia.org", pricing: "https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia",
    price: "Darmowe (licencje CC/PD; wymaga atrybucji)" },
  { key: "openverse", name: "Openverse", icon: "🎨", category: "API danych",
    desc: "Darmowe zdjęcia dań na licencjach CC/PD — drugie bezkosztowe źródło poglądowe obok Wikimedii. Bez klucza.",
    dashboard: "https://openverse.org", pricing: "https://api.openverse.org/v1/",
    price: "Darmowe (CC/PD; bez klucza, opcjonalny token na wyższe limity)" },
  { key: "openstreetmap", name: "OpenStreetMap", icon: "🗺️", category: "API danych",
    desc: "Kafelki mapy (Leaflet) — w labie i na ekranie „Znajdź lokal” w apce. Działa wszędzie (też tam, gdzie brak Google).",
    dashboard: "https://www.openstreetmap.org", pricing: "https://operations.osmfoundation.org/policies/tiles/",
    price: "Darmowe (kafelki wg polityki użycia; bez klucza)" },
  // ── Hosting / infra ──
  { key: "railway", name: "Railway", icon: "🚂", category: "Hosting / infra",
    desc: "Hosting serwera (Hono/Node) + baza Postgres (cache treści, logi kosztów, sample online).",
    dashboard: "https://railway.app/dashboard", pricing: PRICE_SOURCES.egress!,
    price: "Hobby $5/mc (w cenie $5 zużycia), potem pay-as-you-go (CPU/RAM/egress ~$0.10/GB)" },
  // ── Apple & build ──
  { key: "apple", name: "Apple Developer Program", icon: "", category: "Apple & build",
    desc: "Konto deweloperskie: TestFlight, App Store, certyfikaty + provisioning do buildów iOS.",
    dashboard: "https://developer.apple.com/account", pricing: "https://developer.apple.com/support/compare-memberships/",
    price: "$99 / rok (konto individual)" },
  { key: "expo", name: "Expo / EAS", icon: "⚛️", category: "Apple & build",
    desc: "Build iOS — u nas LOKALNY (eas build --local, bez kredytów chmury) + submit na TestFlight.",
    dashboard: "https://expo.dev/accounts", pricing: "https://expo.dev/pricing",
    price: "Build lokalny gratis. Chmura: 30 buildów/mc gratis, potem płatne (Production $99/mc)" },
];

// ─── DEPLOY: ręczna kontrola wysyłki na TestFlight (limit wgrań Apple). Budowanie nie zużywa limitu —
// tylko `eas submit`. Lista gotowych .ipa + wysyłka na żądanie + licznik wgrań w 24h + ostrzeżenia. ───
const MOBILE_DIR = join(HERE, "..", "..", "mobile");
const DEPLOY_FILE = join(HERE, "deploy-state.json"); // notki per .ipa + historia wgrań (gitignored)
const APPLE_ID = "rk@appwithkiss.com"; // sam e-mail nie jest sekretem (jak w build-submit.sh)
const UPLOAD_WARN = 10; // ⚠️ od tylu wgrań w 24h ostrzegamy (z obserwacji realny limit ~15–16)
const UPLOAD_DANGER = 16; // 🛑 od tylu — wstrzymaj się (blisko twardego limitu)
interface DeployState { uploads: { ts: number; ipa: string; ok: boolean; note?: string | null; error?: string | null; buildNumber?: string | null }[]; buildNums?: Record<string, string> }
function loadDeploy(): DeployState {
  try { const j = JSON.parse(readFileSync(DEPLOY_FILE, "utf8")); return { uploads: j.uploads ?? [], buildNums: j.buildNums ?? {} }; }
  catch { return { uploads: [], buildNums: {} }; }
}
function saveDeploy(s: DeployState) { try { writeFileSync(DEPLOY_FILE, JSON.stringify(s, null, 2)); } catch { /* ignore */ } }
// Notka „co w buildzie" = sidecar <ipa>.note pisany przez build-only.sh (MOJE podsumowanie). Read-only.
function noteOf(ipa: string): string {
  try { return readFileSync(join(MOBILE_DIR, ipa + ".note"), "utf8").trim(); } catch { return ""; }
}
// Wyciąga REALNĄ przyczynę odrzucenia z logu eas submit / altool / App Store Connect (co odpowiedział Apple).
function submitErrorReason(log: string): string {
  const pats = [
    /Validation failed[^\n]*?Upload limit reached[^\n]*/i, // limit — pełna odpowiedź
    /Upload limit reached[^\n]*/i,
    /Validation failed[^\n]*/i,
    /Asset validation failed[^\n]*/i,
    /Error uploading ipa file:[^\n]*/i,
    /This bundle is invalid[^\n]*/i,
    /The provided entity[^\n]*/i,
    /already been used[^\n]*/i, // numer builda już użyty
    /\[!\]\s*[^\n]+/, // ogólny błąd fastlane/eas
  ];
  for (const re of pats) { const m = log.match(re); if (m) return m[0].replace(/\s+/g, " ").trim().slice(0, 320); }
  const lines = log.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.length ? lines[lines.length - 1]! : "nieznany błąd").slice(0, 320);
}
// Realny numer builda (CFBundleVersion) z .ipa — nazwa pliku go NIE niesie. Wyciągamy z Info.plist
// (unzip + plutil) RAZ i cache'ujemy (plik .ipa jest niezmienny). Potrzebny, by kasować starsze buildy.
function buildNumberOf(ipa: string): string | null {
  const s = loadDeploy();
  if (s.buildNums && s.buildNums[ipa]) return s.buildNums[ipa]!;
  try {
    const tmp = join(MOBILE_DIR, ".plist-tmp");
    const out = execFileSync("bash", ["-lc",
      `unzip -p ${JSON.stringify(ipa)} 'Payload/*.app/Info.plist' > ${JSON.stringify(tmp)} 2>/dev/null && plutil -extract CFBundleVersion raw ${JSON.stringify(tmp)} 2>/dev/null; rm -f ${JSON.stringify(tmp)}`,
    ], { cwd: MOBILE_DIR, encoding: "utf8", timeout: 15000 }).trim();
    const num = /^\d+$/.test(out) ? out : null;
    if (num) { s.buildNums = s.buildNums ?? {}; s.buildNums[ipa] = num; saveDeploy(s); }
    return num;
  } catch { return null; }
}
// Stan AKTUALNIE trwającej wysyłki (jedna na raz) — log na żywo do podglądu w UI.
let uploadJob: { running: boolean; ipa: string; startedAt: number; log: string; done: boolean; ok: boolean } | null = null;

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
  /** Kiedy migawka trafiła do biblioteki (import) — do sortowania „najnowsze na górze" + znacznika NEW. */
  importedAt?: number;
  images: MetaImage[];
  result?: { restaurantName?: string | null; cuisine?: string; models?: Record<string, string>; menu?: unknown } | null;
  /** Zapisany skan z LABU (najlepsza wersja menu + lokal) — by testy zdjęć nie skanowały od nowa. */
  labScan?: LabScan;
}
interface LabScan {
  scanModel: string;
  at: number;
  peek: unknown;
  menu: { restaurantName: string | null; cuisine: string; itemCount: number; notes?: unknown[]; poorQuality?: boolean; unreadable?: boolean };
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

// Doimportowanie migawek do biblioteki (tożsamość po sig||id). Nowa → dodaj (kopiuj zdjęcia).
// Istniejąca (re-import zmodyfikowanego sampla) → PODMIEŃ wynik + kontekst wejścia, zachowaj lab-owe
// pola (nazwa, ground-truth osobno, labScan) i nie kopiuj zdjęć ponownie. Bump importedAt.
async function ingest(captures: MetaCapture[], readImage: (file: string) => Promise<Buffer | null>) {
  ensureLibrary();
  const existing = loadMeta();
  let added = 0,
    skipped = 0,
    updated = 0;
  for (const cap of captures) {
    const key = cap.sig || cap.id;
    const ex = existing.find((c) => (c.sig || c.id) === key);
    if (ex) {
      // Podmień to, co pochodzi z apki (wynik + wejście); NIE ruszaj nazwy (lab mógł poprawić) ani labScan.
      const changed = JSON.stringify(ex.result ?? null) !== JSON.stringify(cap.result ?? null);
      ex.result = cap.result ?? ex.result;
      if (cap.restaurantHint !== undefined) ex.restaurantHint = cap.restaurantHint;
      if (cap.locationHint !== undefined) ex.locationHint = cap.locationHint;
      if (cap.location !== undefined) ex.location = cap.location;
      if (cap.installId !== undefined) ex.installId = cap.installId;
      ex.importedAt = Date.now();
      if (changed) updated++; else skipped++;
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
    existing.push({ ...cap, images: newImages, importedAt: Date.now() });
    added++;
  }
  saveMeta(existing);
  return { added, skipped, updated };
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
    importedAt: cap.importedAt ?? null,
    exifLocations: cap.images.map((im) => im.exifLocation ?? null),
    images: cap.images.length,
    result: cap.result
      ? { restaurantName: cap.result.restaurantName ?? null, cuisine: cap.result.cuisine ?? null }
      : null,
    labScan: cap.labScan
      ? { scanModel: cap.labScan.scanModel, at: cap.labScan.at, itemCount: cap.labScan.menu.itemCount, hasVenue: !!cap.labScan.venue, poorQuality: !!cap.labScan.menu.poorQuality, unreadable: !!cap.labScan.menu.unreadable }
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

// Buduje zip migawki labu (metadata.json + zdjęcia z library/images) — format eksportu apki,
// żeby apka mogła go zaimportować. Zwraca base64 + meta do listy. null gdy brak zdjęć.
async function buildCaptureZipBase64(cap: MetaCapture): Promise<{ zipBase64: string; meta: Record<string, unknown> } | null> {
  const zip = new JSZip();
  const imagesDir = zip.folder("images")!;
  const images: { file: string; mediaType: string; exifLocation?: { lat: number; lng: number } }[] = [];
  for (const im of cap.images ?? []) {
    const base = im.file.split("/").pop()!;
    try {
      imagesDir.file(base, readFileSync(join(LIB_IMAGES, base)));
      images.push({ file: `images/${base}`, mediaType: im.mediaType || "image/jpeg", exifLocation: im.exifLocation });
    } catch { /* brak pliku — pomiń */ }
  }
  if (!images.length) return null;
  // CZYSTY zestaw do obróbki w apce: tylko zdjęcia + GPS + (opcjonalna) nazwa. BEZ wyników skanu,
  // labScan, ground-truth, hintów — apka ma to przeskanować od zera.
  const clean = {
    id: cap.id,
    createdAt: cap.createdAt,
    name: cap.name || undefined,
    location: cap.location ?? null,
    locationSource: cap.locationSource ?? null,
    locationHint: cap.locationHint || undefined,
    sig: cap.sig,
    images,
  };
  zip.file("metadata.json", JSON.stringify({ format: "menubutbetter.captures", version: 1, count: 1, captures: [clean] }));
  const zipBase64 = await zip.generateAsync({ type: "base64", compression: "STORE" });
  const meta = { name: cap.name ?? null, images: images.length, locationHint: cap.locationHint ?? null, createdAt: cap.createdAt, fromLab: true };
  return { zipBase64, meta };
}

// Lab → serwer (kolejka DLA APKI): pcha migawkę z biblioteki labu na serwer z target='app'.
app.post("/api/push-to-app", async (c) => {
  const { captureId } = await c.req.json<{ captureId: string }>();
  const cap = loadMeta().find((x) => x.id === captureId);
  if (!cap) return c.json({ error: "nie ma migawki" }, 404);
  const built = await buildCaptureZipBase64(cap);
  if (!built) return c.json({ error: "brak zdjęć migawki w bibliotece" }, 400);
  try {
    const r = await prodFetch("/samples", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hash: cap.sig || cap.id, meta: built.meta, zipBase64: built.zipBase64, target: "app" }) });
    return c.json({ ok: true, ...((await r.json()) as object) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// Lab: podgląd kolejki sampli czekających na import w APCE (target='app', jeszcze niezaimportowane).
app.get("/api/app-samples", async (c) => {
  try {
    const r = await prodFetch("/samples?pending=1&target=app");
    const d = (await r.json()) as { samples?: unknown[] };
    return c.json({ prodUrl: PROD_URL, configured: !!PROD_TOKEN, samples: d.samples ?? [] });
  } catch (e) {
    return c.json({ error: `Nie połączono z serwerem (${PROD_URL}): ${(e as Error).message}`, prodUrl: PROD_URL }, 502);
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

// Ustaw/wyczyść wymuszoną nazwę sampla (z samplowania w apce bywa błędna). Puste = wyczyść.
app.post("/api/capture-name", async (c) => {
  const { captureId, name } = await c.req.json<{ captureId: string; name: string }>();
  const all = loadMeta();
  const cap = all.find((x) => x.id === captureId);
  if (!cap) return c.json({ error: "nie ma migawki" }, 404);
  const clean = (name ?? "").trim();
  cap.name = clean || undefined;
  saveMeta(all);
  return c.json({ ok: true, name: cap.name ?? null });
});

// Popraw/usuń WYNIK skanu zapisany przy samplu (bywa zły lokal, np. z innego skanu). Puste/clear = usuń wynik.
app.post("/api/capture-result", async (c) => {
  const { captureId, restaurantName, clear } = await c.req.json<{ captureId: string; restaurantName?: string | null; clear?: boolean }>();
  const all = loadMeta();
  const cap = all.find((x) => x.id === captureId);
  if (!cap) return c.json({ error: "nie ma migawki" }, 404);
  const name = (restaurantName ?? "").trim();
  if (clear || !name) cap.result = null;
  else cap.result = { ...(cap.result ?? { restaurantName: null }), restaurantName: name };
  saveMeta(all);
  return c.json({ ok: true, result: cap.result ?? null });
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
  const { menu, usage, readable, poorQuality } = await extractMenu(images, {
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
    menu: { restaurantName: menu.restaurant_name, cuisine: menu.cuisine, itemCount: items.length, notes: menu.notes ?? [], poorQuality: poorQuality === true, unreadable: readable === false },
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
app.get("/api/cost-log", async (c) => {
  const period = c.req.query("period") || "all";
  const now = Date.now();
  const cutoff = period === "today" ? now - 24 * 3600e3 : period === "7d" ? now - 7 * 24 * 3600e3 : period === "30d" ? now - 30 * 24 * 3600e3 : 0;
  const egress = otherRate("egress");
  // REALNE użycie z PRODUKCJI (skany z apki) — events: op, model, tokeny, koszt, data.cached, install_id
  // → CostEntry. Łączymy z lokalnymi sim-scanami labu. Token chroni globalnie (prodFetch go dokłada).
  let prodEntries: CostEntry[] = [];
  let prodErr: string | null = null;
  try {
    const r = await prodFetch("/events?limit=3000");
    const evs = ((await r.json()) as { events?: Record<string, any>[] }).events ?? [];
    prodEntries = evs
      // type "api" = nie-AI provider (Serper/Places/Wiki/Openverse…) z liczbą zapytań w data.calls.
      .filter((e) => (e.type === "ai" || e.type === "scan" || e.type === "api") && (e.model || e.cost_usd != null || e.type === "api"))
      .map((e): CostEntry => {
        const inTok = Number(e.input_tokens) || 0, outTok = Number(e.output_tokens) || 0;
        const prov = (e.provider as string) || (e.model ? apiTag(e.model) : "claude");
        const restaurant = (e.data?.restaurant as string) || undefined;
        const calls = e.type === "api" ? (Number(e.data?.calls) || 1) : 1; // nie-AI: realna liczba zapytań
        return {
          ts: Date.parse(e.created_at) || 0,
          ms: 0,
          op: (e.op as string) || (e.type as string),
          meta: { lokal: restaurant, installId: (e.install_id as string) || undefined, prod: true, dish: e.data?.dish, data: e.data },
          delta: [{ provider: prov, calls, inTok, outTok, costUsd: Number(e.cost_usd) || 0, bytesSent: Number(e.data?.bytesSent) || 0, bytesRecv: 0 }],
          models: e.model ? [{ model: e.model as string, inTok, outTok, calls: 1 }] : [],
          cacheHits: e.data?.cached ? 1 : 0,
        };
      });
  } catch (e) { prodErr = (e as Error).message; }
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
  const entries = [...readCostLog(), ...prodEntries].filter((e) => e.ts >= cutoff).map(enrich).sort((a, b) => b.ts - a.ts);
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
  // REKONSTRUKCJA SESJI dla STARYCH zdarzeń (bez data.sessionId i bez captureId): klastrujemy
  // chronologicznie. Nowa sesja = pojawia się SKAN (z 3-min buforem, by wielopartiowy skan się nie
  // rozpadł) ALBO duża przerwa (>8 min). Fałszywe, stabilne id per klaster — żeby historia miała sensowne
  // sesje (po skanie), a nie zlepek wszystkiego po nazwie lokalu.
  const realSid = (e: (typeof entries)[number]) => (e.meta?.data as { sessionId?: string } | undefined)?.sessionId;
  const synth = new Map<(typeof entries)[number], string>();
  {
    const GAP = 8 * 60_000, SCAN_COALESCE = 3 * 60_000;
    const chrono = entries.filter((e) => !realSid(e) && !(e.meta?.captureId)).sort((a, b) => a.ts - b.ts);
    let cur = "", lastTs = 0, lastScanTs = 0, hasScan = false, n = 0;
    for (const e of chrono) {
      const gap = lastTs && e.ts - lastTs > GAP;
      const newScan = e.op === "scan" && hasScan && e.ts - lastScanTs > SCAN_COALESCE;
      if (!cur || gap || newScan) { cur = "h" + (++n).toString(36) + Math.round(e.ts / 1000).toString(36); hasScan = false; }
      if (e.op === "scan") { hasScan = true; lastScanTs = e.ts; }
      synth.set(e, cur);
      lastTs = e.ts;
    }
  }
  const groupOf = (e: (typeof entries)[number]): { key: string; label: string; installId?: string } => {
    // SESJA usera = wspólny element WSZYSTKICH ops jednego skanu. Realne sessionId (nowe buildy) → bezpośrednio;
    // sample labu → captureId; stare zdarzenia prod → zrekonstruowana sesja (synth). Nazwa lokalu = etykieta.
    const inst = e.meta?.installId as string | undefined;
    const sid = realSid(e);
    if (sid) return { key: "s:" + sid, label: (e.meta?.lokal as string) || ("Sesja " + sid.slice(0, 8)), installId: inst };
    const cid = e.meta?.captureId as string | undefined;
    if (cid) return { key: "c:" + cid, label: capName(cid) };
    const ssid = synth.get(e);
    if (ssid) return { key: "s:" + ssid, label: (e.meta?.lokal as string) || ("Sesja " + ssid), installId: inst };
    const lok = e.meta?.lokal as string | undefined;
    if (lok) return { key: "r:" + lok.toLowerCase(), label: lok, installId: inst };
    if (inst) return { key: "i:" + inst, label: "📱 " + inst.slice(0, 16), installId: inst };
    return { key: "—", label: "Inne (niepowiązane z sesją)" };
  };
  type Prov = { provider: string; calls: number; inTok: number; outTok: number; costUsd: number; bytesSent: number; bytesRecv: number };
  const gmap: Record<string, { key: string; label: string; installId?: string; totalCost: number; tokenCost: number; apiCost: number; dataCost: number; count: number; cacheHits: number; bytesSent: number; bytesRecv: number; ts: number; byProvider: Record<string, Prov>; entries: typeof entries }> = {};
  for (const e of entries) {
    const { key, label, installId } = groupOf(e);
    const g = (gmap[key] = gmap[key] || { key, label, installId, totalCost: 0, tokenCost: 0, apiCost: 0, dataCost: 0, count: 0, cacheHits: 0, bytesSent: 0, bytesRecv: 0, ts: 0, byProvider: {}, entries: [] });
    // Sesja: gdy etykieta to placeholder „Sesja…", a ten wpis zna nazwę lokalu → podmień na nazwę.
    const lok = e.meta?.lokal as string | undefined;
    if (lok && g.label.startsWith("Sesja ")) g.label = lok;
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
  return c.json({ period, egressUsdPerGB: egress, agg, savings, groups, prodCount: prodEntries.length, prodErr, prodUrl: PROD_URL });
});

app.post("/api/cost-log-clear", (c) => {
  try {
    if (existsSync(COSTLOG_FILE)) unlinkSync(COSTLOG_FILE);
  } catch {
    /* brak */
  }
  return c.json({ ok: true });
});

// --- CACHE treści: statystyki/przegląd/rozmiar. Realny cache jest na PRODUKCJI (tam idą skany z
// apki) — pytamy produkcję; lokalny cache labu (sim-scany) jest fallbackiem, gdy brak połączenia. ---
app.get("/api/cache-stats", async (c) => {
  try {
    const r = await prodFetch("/cache-stats");
    return c.json({ ...((await r.json()) as object), from: "prod", prodUrl: PROD_URL });
  } catch (e) {
    const stats = await cacheStats();
    return c.json({ ...stats, sessionHits: cacheHitsSnapshot(), from: "local", fromErr: `produkcja niedostępna (${(e as Error).message}) — pokazuję cache lokalny labu` });
  }
});
app.get("/api/cache-browse", async (c) => {
  const kind = c.req.query("kind") || "";
  const q = c.req.query("q") || "";
  const limit = Number(c.req.query("limit")) || 100;
  try {
    const r = await prodFetch(`/cache-browse?limit=${limit}${kind ? "&kind=" + encodeURIComponent(kind) : ""}${q ? "&q=" + encodeURIComponent(q) : ""}`);
    return c.json({ ...((await r.json()) as object), from: "prod" }); // zachowuje wewnętrzne source (pg/l1)
  } catch {
    return c.json({ ...(await cacheBrowse({ kind: kind || undefined, q: q || undefined, limit })), from: "local" });
  }
});
app.get("/api/cache-size", async (c) => {
  const rate = otherRate("storage"); // $/GB-mies. z cennika labu
  try {
    const r = await prodFetch("/cache-size");
    const sz = (await r.json()) as { bytes: number };
    return c.json({ ...sz, storageUsdPerGbMonth: rate, storageCostMonthly: (sz.bytes / 1e9) * rate, from: "prod" });
  } catch {
    const sz = await cacheSize();
    return c.json({ ...sz, storageUsdPerGbMonth: rate, storageCostMonthly: (sz.bytes / 1e9) * rate, from: "local" });
  }
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

// Katalog zewnętrznych serwisów (nazwa/opis/panel/cennik/cena orientacyjna).
app.get("/api/services", (c) => c.json({ services: SERVICES }));

// „Zaciągnij aktualny cennik" — serwer (bez CORS) pobiera stronę cennika i wyłuskuje best-effort
// fragmenty cenowe + tytuł. Strony renderowane w JS mogą nie dać kwot → wtedy zwracamy pusto i UI
// kieruje do źródła. To PODGLĄD, nie autorytet (zweryfikuj na stronie).
app.post("/api/service-price", async (c) => {
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }));
  if (!url || !/^https?:\/\//i.test(url)) return c.json({ ok: false, error: "zły url" }, 400);
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (MenuButBetter-lab price-peek)", accept: "text/html" }, signal: AbortSignal.timeout(12000) });
    const html = await r.text();
    const decode = (s: string) => s
      .replace(/&quot;|&#34;/gi, '"').replace(/&#36;/gi, "$").replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;|&#38;/gi, "&").replace(/&#x27;|&#39;|&apos;/gi, "'").replace(/&gt;/gi, ">").replace(/&lt;/gi, "<");
    const title = decode((html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "")).replace(/\s+/g, " ").trim().slice(0, 140);
    const text = decode(html
      .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    // Słowa-klucze cenowe (okres/jednostka) — odsiewają szum (przykłady, ceny produktów ze stron).
    const KW = /(per|\/|\ba\b|za\b)\s?(mo\b|month|mes|miesi|yr\b|year|rok|user|seat|1[,. ]?0{3}|1\s?[kK]\b|1\s?[mM]\b|million|mtok|token|gb\b|build|credit|request|\breq\b|call|day|dzie|hour)/i;
    const collect = (requireCtx: boolean) => {
      const out: string[] = []; const seen = new Set<string>();
      const rx = /\$\s?\d[\d.,]*\s?[KkMm]?[^$•|\n]{0,34}/g; let m: RegExpExecArray | null;
      while ((m = rx.exec(text)) && out.length < 12) {
        const s = m[0].replace(/\s+/g, " ").trim().replace(/[\s,.;:]+$/, "");
        if (s.length > 2 && (!requireCtx || KW.test(s)) && !seen.has(s)) { seen.add(s); out.push(s.slice(0, 50)); }
      }
      return out;
    };
    let snippets = collect(true); // najpierw z kontekstem cenowym (czysto)
    let noisy = false;
    if (snippets.length === 0) { snippets = collect(false).slice(0, 8); noisy = snippets.length > 0; } // fallback: same kwoty
    return c.json({ ok: true, status: r.status, title, snippets, noisy });
  } catch (e) {
    return c.json({ ok: false, error: String((e as Error).message || e) });
  }
});

// ─── Deploy: ręczna kontrola wysyłki gotowych .ipa na TestFlight (kontrola limitu Apple) ───
const IPA_RE = /^build-[0-9]+\.ipa$/; // sztywny wzorzec nazwy → zero path-traversal
function listBuilds(): { ipa: string; sizeMB: number; mtime: number; note: string; buildNumber: string | null }[] {
  let names: string[] = [];
  try { names = readdirSync(MOBILE_DIR).filter((f) => IPA_RE.test(f)); } catch { /* brak katalogu */ }
  return names
    .map((ipa) => {
      let sizeMB = 0, mtime = 0;
      try { const s = statSync(join(MOBILE_DIR, ipa)); sizeMB = +(s.size / 1048576).toFixed(1); mtime = s.mtimeMs; } catch { /* ignore */ }
      return { ipa, sizeMB, mtime, note: noteOf(ipa), buildNumber: buildNumberOf(ipa) };
    })
    .sort((a, b) => Number(b.buildNumber ?? 0) - Number(a.buildNumber ?? 0) || b.mtime - a.mtime);
}
function uploads24h(s: DeployState): number {
  const cut = Date.now() - 24 * 3600_000;
  return s.uploads.filter((u) => u.ok && u.ts >= cut).length;
}
app.get("/api/deploy/state", (c) => {
  const s = loadDeploy();
  const used = uploads24h(s);
  const cut = Date.now() - 24 * 3600_000;
  // Apple REALNIE odrzucił ostatnio (limit) → twardy „X", ważniejszy niż sam licznik.
  const appleBlocked = s.uploads.some((u) => !u.ok && u.ts >= cut && /limit/i.test(u.error || ""));
  const rejected24h = s.uploads.filter((u) => !u.ok && u.ts >= cut).length;
  const lastReject = s.uploads.find((u) => !u.ok); // najnowsza odmowa/błąd (lista jest od najnowszych)
  const level = appleBlocked ? "blocked" : used >= UPLOAD_DANGER ? "danger" : used >= UPLOAD_WARN ? "warn" : "ok";
  return c.json({
    builds: listBuilds(),
    uploads: s.uploads.slice(0, 20),
    used24h: used, warn: UPLOAD_WARN, danger: UPLOAD_DANGER, appleBlocked, rejected24h,
    lastRejectAt: lastReject ? lastReject.ts : null,
    level,
    job: uploadJob,
    appleId: APPLE_ID,
  });
});
app.post("/api/deploy/delete-build", async (c) => {
  const b = await c.req.json<{ ipa?: string }>().catch(() => ({}) as { ipa?: string });
  if (!b.ipa || !IPA_RE.test(b.ipa)) return c.json({ error: "zła nazwa .ipa" }, 400);
  if (uploadJob?.running && uploadJob.ipa === b.ipa) return c.json({ error: "Ten build jest właśnie wysyłany." }, 409);
  try { unlinkSync(join(MOBILE_DIR, b.ipa)); } catch { /* już nie ma */ }
  try { unlinkSync(join(MOBILE_DIR, b.ipa + ".note")); } catch { /* brak sidecara */ }
  const s = loadDeploy(); if (s.buildNums) delete s.buildNums[b.ipa]; saveDeploy(s);
  return c.json({ ok: true });
});
app.post("/api/deploy/upload", async (c) => {
  const b = await c.req.json<{ ipa?: string }>().catch(() => ({}) as { ipa?: string });
  if (!b.ipa || !IPA_RE.test(b.ipa)) return c.json({ error: "zła nazwa .ipa" }, 400);
  if (uploadJob?.running) return c.json({ error: "Wysyłka już trwa — poczekaj na zakończenie." }, 409);
  if (!existsSync(join(MOBILE_DIR, b.ipa))) return c.json({ error: "Brak pliku .ipa (zbuduj najpierw)." }, 404);
  const ipa = b.ipa;
  uploadJob = { running: true, ipa, startedAt: Date.now(), log: "", done: false, ok: false };
  // Budowanie nie zużywa limitu — TYLKO ta wysyłka. eas submit czyta eas.json (ascAppId) → non-interactive.
  const sh = `export EXPO_APPLE_ID=${JSON.stringify(APPLE_ID)}; [ -f .apple-secrets ] && source .apple-secrets; eas submit --platform ios --profile production --path ${JSON.stringify(ipa)} --non-interactive`;
  const child = spawn("bash", ["-lc", sh], { cwd: MOBILE_DIR });
  const append = (d: Buffer) => { if (uploadJob) uploadJob.log = (uploadJob.log + d.toString()).slice(-8000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (e) => { if (uploadJob) { uploadJob.running = false; uploadJob.done = true; uploadJob.ok = false; uploadJob.log += `\nSPAWN ERROR: ${e.message}`; } });
  child.on("close", () => {
    if (!uploadJob) return;
    const log = uploadJob.log;
    const limit = /Upload limit reached/i.test(log);
    const ok = /Submitted your app to Apple/i.test(log) && !limit && !/Error uploading ipa/i.test(log);
    uploadJob.running = false; uploadJob.done = true; uploadJob.ok = ok;
    const s = loadDeploy();
    const noteForRecord = noteOf(ipa) || null; // z sidecara, PRZED czyszczeniem (skasuje plik .note)
    const upBuildNum = buildNumberOf(ipa); // też przed czyszczeniem (skasuje plik + cache)
    // Po UDANEJ wysyłce: skasuj wszystkie .ipa z numerem ≤ wgrany (łącznie z wgranym) — TestFlight i tak
    // odrzuci niższy/równy numer, więc to bezużyteczne pliki. Czyści też zużyty build + jego sidecar .note.
    const cleaned: string[] = [];
    if (ok) {
      const upNum = Number(upBuildNum ?? 0);
      if (upNum > 0) for (const b of listBuilds()) {
        const n = Number(b.buildNumber ?? 0);
        if (n > 0 && n <= upNum) {
          try { unlinkSync(join(MOBILE_DIR, b.ipa)); cleaned.push(`#${n}`); } catch { /* już nie ma */ }
          try { unlinkSync(join(MOBILE_DIR, b.ipa + ".note")); } catch { /* brak */ }
          if (s.buildNums) delete s.buildNums[b.ipa];
        }
      }
      if (cleaned.length) uploadJob.log += `\n🧹 Usunięto zużyte/starsze buildy: ${cleaned.join(", ")}`;
    }
    // Przy niepowodzeniu zapisz REALNĄ odpowiedź Apple/altool z logu (nie generyczny tekst).
    const reason = ok ? (cleaned.length ? `🧹 posprzątano ${cleaned.length} starszych/zużytych` : null) : submitErrorReason(log);
    s.uploads.unshift({ ts: Date.now(), ipa, ok, buildNumber: upBuildNum, note: noteForRecord, error: reason });
    s.uploads = s.uploads.slice(0, 100);
    saveDeploy(s);
  });
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
// Tylko localhost: lab nie ma auth i odpala płatne modele — nie wystawiamy go na LAN (domyślnie 0.0.0.0).
serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
console.log(`\n🔬 LAB modeli: http://localhost:${PORT}`);
console.log(`   biblioteka: ${LIBRARY} (${loadMeta().length} migawek)\n`);
