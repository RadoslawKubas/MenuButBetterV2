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
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
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
import { MODELS, DEFAULT_MODEL, usesOpenAiApi, type ModelId } from "../src/models.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "..", "samples", "captures"); // stare eksporty (do auto-migracji)
const RESULTS_DIR = join(HERE, "results");

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
  images: MetaImage[];
  result?: { restaurantName?: string | null; cuisine?: string; models?: Record<string, string>; menu?: unknown } | null;
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
    exifLocations: cap.images.map((im) => im.exifLocation ?? null),
    images: cap.images.length,
    result: cap.result
      ? { restaurantName: cap.result.restaurantName ?? null, cuisine: cap.result.cuisine ?? null }
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

// 1) Skan menu (+ opcjonalnie znajdź lokal w Places/TripAdvisor — jak /restaurant w apce).
app.post("/api/sim-scan", async (c) => {
  const { captureId, scanModel, withVenue } = await c.req.json<{ captureId: string; scanModel?: ModelId; withVenue?: boolean }>();
  const cap = loadMeta().find((x) => x.id === captureId);
  if (!cap) return c.json({ error: "nie ma migawki" }, 404);
  const images = allImageInputs(cap);
  if (!images.length) return c.json({ error: "brak zdjęć" }, 400);
  const model = (scanModel && scanModel in MODELS ? scanModel : DEFAULT_MODEL) as ModelId;
  const t0 = Date.now();
  const { menu, usage } = await extractMenu(images, { targetLang: "polski", locationHint: cap.locationHint, model });
  const items = (menu.sections ?? []).flatMap((s: any) =>
    (s.items ?? []).map((it: any) => ({
      section: s.name,
      original: it.original,
      translated: it.translated,
      photoQuery: it.photo_query,
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
        nameVerified: rest.nameVerified, // czy Places trafił w nazwę (Tier 0: pewność lokalu)
        photoNames: rest.photoNames ?? [],
        taPhotos: (ta?.photos ?? []).map((p) => ({ url: p.url, caption: p.caption })),
        taUrl: ta?.url ?? null,
      };
    }
  }
  return c.json({
    ms: Date.now() - t0,
    usage,
    scanModel: model,
    menu: { restaurantName: menu.restaurant_name, cuisine: menu.cuisine, sections: menu.sections.length, itemCount: items.length },
    items,
    venue,
  });
});

// 2) Zdjęcia dla JEDNEJ pozycji — DOKŁADNIE runDishPhotos z apki, z pełnym śladem debug.
app.post("/api/sim-dish", async (c) => {
  const b = await c.req.json<{
    dish: string;
    photoQuery?: string;
    cuisine?: string;
    restaurantName?: string;
    website?: string;
    verifyModel?: string;
    num?: number;
    verify?: boolean;
  }>();
  if (!b.dish?.trim()) return c.json({ error: "brak nazwy dania" }, 400);
  try {
    const { photos, usage, debug } = await runDishPhotos({
      dish: b.dish,
      photoQuery: b.photoQuery,
      restaurantHint: b.restaurantName, // w apce hint ≈ nazwa lokalu (bias zapytań portalowych)
      restaurantName: b.restaurantName,
      cuisine: b.cuisine,
      website: b.website,
      num: b.num ?? 4,
      verify: b.verify !== false,
      verifyModel: b.verifyModel,
    });
    return c.json({ photos, usage, debug });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// 3) Tier 0 — dopasowanie puli zdjęć lokalu (Google Places + TripAdvisor) do dań.
app.post("/api/sim-venue", async (c) => {
  const b = await c.req.json<{ dishes: string[]; cuisine?: string; photoNames?: string[]; taPhotos?: { url: string; caption: string | null }[]; model?: string; certain?: boolean }>();
  const t0 = Date.now();
  try {
    const { matches, usage } = await matchVenuePhotos({
      photoNames: b.photoNames ?? [],
      taPhotos: b.taPhotos ?? [],
      dishes: b.dishes ?? [],
      cuisine: b.cuisine,
      model: b.model,
      certain: b.certain !== false,
    });
    return c.json({ ms: Date.now() - t0, usage, pool: (b.photoNames?.length ?? 0) + (b.taPhotos?.length ?? 0), matches });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
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
serve({ fetch: app.fetch, port: PORT });
console.log(`\n🔬 LAB modeli: http://localhost:${PORT}`);
console.log(`   biblioteka: ${LIBRARY} (${loadMeta().length} migawek)\n`);
