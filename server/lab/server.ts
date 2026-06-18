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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { extractMenu, contextText, SYSTEM as MENU_SYSTEM, type InputImage } from "../src/menu.ts";
import { quickPeek, SYSTEM as PEEK_SYSTEM, INSTRUCTION as PEEK_INSTRUCTION } from "../src/quickPeek.ts";
import { describeDish, SYSTEM as DESCRIBE_SYSTEM } from "../src/dishInfo.ts";
import { scoreDishPhotos, VERIFY_SYSTEM, verifyInstruction } from "../src/verifyPhotos.ts";
import { matchVenuePhotos, VENUE_SYSTEM, venueInstruction } from "../src/venuePhotos.ts";
import { genericWebImages } from "../src/dishPhotos.ts";
import { findRestaurant } from "../src/places.ts";
import { MODELS, type ModelId } from "../src/models.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "..", "samples", "captures");
const RESULTS_DIR = join(HERE, "results");

// --- Wybór eksportu (folder z metadata.json). Domyślnie najnowszy w samples/captures. -----
function latestExportDir(): string {
  if (process.env.LAB_DIR) return process.env.LAB_DIR;
  try {
    const dirs = readdirSync(SAMPLES, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("mbb-captures"))
      .map((d) => d.name)
      .sort();
    if (dirs.length) return join(SAMPLES, dirs[dirs.length - 1]);
  } catch {
    /* brak */
  }
  return SAMPLES;
}
let EXPORT_DIR = latestExportDir();

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
  const p = join(EXPORT_DIR, "metadata.json");
  if (!existsSync(p)) return [];
  const j = JSON.parse(readFileSync(p, "utf8")) as { captures?: MetaCapture[] };
  return j.captures ?? [];
}

function gtPath(): string {
  return join(EXPORT_DIR, "ground-truth.json");
}
function loadGroundTruth(): Record<string, GroundTruth> {
  try {
    return JSON.parse(readFileSync(gtPath(), "utf8"));
  } catch {
    return {};
  }
}
async function saveGroundTruth(gt: Record<string, GroundTruth>): Promise<void> {
  await writeFile(gtPath(), JSON.stringify(gt, null, 2));
}

function imageInput(cap: MetaCapture, idx = 0): InputImage | null {
  const im = cap.images[idx];
  if (!im) return null;
  const buf = readFileSync(join(EXPORT_DIR, im.file));
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
    out.push({ dish: it.original, len: text.length, sample: text.slice(0, 180) });
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
  const { matches, usage } = await matchVenuePhotos({ photoNames, taPhotos, dishes, cuisine: menu.cuisine, model });
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

async function judgeScan(cap: MetaCapture, scanByModel: Record<string, any>, judgeModel: string) {
  const images = allImageInputs(cap);
  const content: Anthropic.ContentBlockParam[] = [];
  images.forEach((im) => content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.base64 } }));
  const lines = Object.entries(scanByModel).map(([model, r]) => {
    const names = (r.menu?.sections ?? []).flatMap((s: any) => s.items.map((it: any) => it.original)).slice(0, 60);
    return `MODEL ${model}: lokal="${r.restaurantName ?? ""}", kuchnia="${r.cuisine ?? ""}", sekcje=${r.sections}, dania=${r.items}, koszt=$${(r.cost ?? 0).toFixed(4)}\n  pozycje: ${names.join(" | ")}`;
  });
  content.push({
    type: "text",
    text:
      "Oto ZDJĘCIA menu oraz wyniki ODCZYTU różnych modeli. Oceń każdy model: completeness " +
      "(ile pozycji wychwycił względem obrazu) i accuracy (poprawność nazw/cen/tłumaczeń), 0-100. " +
      "Wskaż best (najlepszy) oraz goodEnough (NAJTAŃSZY wystarczająco dobry do TEGO menu). " +
      "Zwięzłe notatki po polsku.\n\n" +
      lines.join("\n"),
  });
  const resp = await anthropic.messages.create({
    model: judgeModel,
    max_tokens: 1500,
    system: "Jesteś rygorystycznym sędzią jakości odczytu menu z obrazu. Oceniasz obiektywnie, względem tego co WIDAĆ na zdjęciu.",
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA } },
  });
  const text = resp.content.find((b) => b.type === "text");
  return text && text.type === "text" ? JSON.parse(text.text) : null;
}

// --- HTTP --------------------------------------------------------------------------------
const app = new Hono();
app.use("/*", cors());

app.get("/", (c) => c.html(readFileSync(join(HERE, "public", "index.html"), "utf8")));

app.get("/api/state", (c) => {
  const meta = loadMeta();
  const gt = loadGroundTruth();
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
    groundTruth: gt[cap.id] ?? null,
  }));
  const models = Object.entries(MODELS).map(([id, def]) => ({ id, label: def.label, provider: def.provider, price: def.price }));
  return c.json({ exportDir: EXPORT_DIR, captures, models });
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
  const buf = readFileSync(join(EXPORT_DIR, im.file));
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

app.post("/api/annotate", async (c) => {
  const { captureId, groundTruth } = await c.req.json<{ captureId: string; groundTruth: GroundTruth | null }>();
  const gt = loadGroundTruth();
  if (groundTruth) gt[captureId] = groundTruth;
  else delete gt[captureId];
  await saveGroundTruth(gt);
  return c.json({ ok: true });
});

app.post("/api/run", async (c) => {
  const { captureIds, models, operations, withVenue } = await c.req.json<{
    captureIds: string[];
    models: ModelId[];
    operations: ("peek" | "scan" | "describe" | "verify" | "venuePhotos")[];
    withVenue?: boolean;
  }>();
  const meta = loadMeta();
  const gt = loadGroundTruth();
  const results: any[] = [];
  for (const id of captureIds) {
    const cap = meta.find((x) => x.id === id);
    if (!cap) continue;
    const perCapture: any = { captureId: id, locationHint: cap.locationHint, groundTruth: gt[id] ?? null, byModel: {} };
    for (const model of models) {
      const m: any = {};
      try {
        if (operations.includes("peek")) m.peek = await opPeek(cap, model);
        if (operations.includes("scan")) m.scan = await opScan(cap, model, !!withVenue, gt[id]);
        if (operations.includes("describe")) m.describe = await opDescribe(cap, model);
        if (operations.includes("verify")) m.verify = await opVerify(cap, model);
        if (operations.includes("venuePhotos")) m.venuePhotos = await opVenuePhotos(cap, model);
      } catch (e) {
        m.error = (e as Error).message;
      }
      perCapture.byModel[model] = m;
    }
    results.push(perCapture);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = join(RESULTS_DIR, `run-${stamp}.json`);
  await writeFile(file, JSON.stringify({ at: Date.now(), models, operations, withVenue, results }, null, 2));
  return c.json({ runId: stamp, file, results });
});

app.post("/api/judge", async (c) => {
  const { results, judgeModel } = await c.req.json<{ results: any[]; judgeModel?: string }>();
  const model = judgeModel && judgeModel in MODELS ? judgeModel : "claude-sonnet-4-6";
  const judgments: any[] = [];
  for (const cap of results) {
    const scanByModel: Record<string, any> = {};
    for (const [mid, m] of Object.entries<any>(cap.byModel)) {
      if (m.scan?.ok) scanByModel[mid] = m.scan;
    }
    if (Object.keys(scanByModel).length < 1) continue;
    try {
      const verdict = await judgeScan(loadMeta().find((x) => x.id === cap.captureId)!, scanByModel, model);
      judgments.push({ captureId: cap.captureId, verdict });
    } catch (e) {
      judgments.push({ captureId: cap.captureId, error: (e as Error).message });
    }
  }
  return c.json({ judgeModel: model, judgments });
});

const PORT = Number(process.env.LAB_PORT ?? 8799);
serve({ fetch: app.fetch, port: PORT });
console.log(`\n🔬 LAB modeli: http://localhost:${PORT}`);
console.log(`   eksport: ${EXPORT_DIR}\n`);
