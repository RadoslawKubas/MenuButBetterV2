// SZEROKA PULA Z LOKALU → DANIA (krok produkcyjny „photoVenuePool", sterowany z LABu; też w LAB sim).
// Zamiast szukać zdjęć PER DANIE (N×(wyszukiwanie Serper + weryfikacja vision)), zbieramy JEDNĄ szeroką
// pulę zdjęć z lokalu (Serper: strona www `site:domena` + portale/social, plus Google Places + TripAdvisor)
// i JEDNYM przejściem vision przypisujemy każde zdjęcie do dania z menu. Cel: 1 „harvest" + 1 wywołanie
// wizji na cały lokal zamiast osobnej rundy per pozycja. Wpięte w /venue-photos (http.ts) obok klasycznego Tier 0.
import Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { trackedFetch, track, recordUsage, recordBytes } from "./apiLog.ts";
import { fetchPlacePhoto } from "./places.ts";
import { hostOf } from "./dishPhotos.ts";
import { venueNameInUrl } from "./dishPhotosPipeline.ts";
import { usageFrom, ZERO_USAGE, type Usage } from "./usage.ts";
import { openaiVisionJson } from "./openaiClient.ts";
import { usesOpenAiApi, apiTag } from "./models.ts";

const client = new Anthropic({ maxRetries: 4 });
const MODEL = "claude-sonnet-4-6";

// Próg pewności dopasowania danie↔zdjęcie (jak w Tier 0). Niżej — zbyt luźne.
const MATCH_MIN = 0.5;

// Portale recenzenckie + social, na których lokal ma profil ze zdjęciami od ludzi.
const PORTALS = ["tripadvisor.com", "yelp.com", "zomato.com", "thefork.com", "foursquare.com", "facebook.com", "instagram.com"];

export type PoolSource = "site" | "portal" | "google" | "tripadvisor";

export interface PoolPhoto {
  source: PoolSource;
  /** Bezpośredni URL obrazka (site/portal/tripadvisor). */
  url?: string;
  /** Google Places: nazwa zasobu zdjęcia (pobieramy przez fetchPlacePhoto). */
  photoName?: string;
  /** Strona, z której pochodzi obraz (kontekst / link). */
  contextUrl?: string;
  domain?: string;
  caption?: string | null;
  /** Czy nazwa lokalu jest w URL źródła (wskazówka „z TEGO lokalu", nie generyk). */
  nameInUrl?: boolean;
}

export interface HarvestQuery {
  label: string;
  query: string;
  returned: number;
}

interface SerperImg {
  imageUrl?: string;
  thumbnailUrl?: string;
  source?: string;
  domain?: string;
  link?: string;
}

/** Niskopoziomowe szukanie obrazów w Serper (Google Images), z liczeniem kosztu (trackedFetch). */
async function serperImages(query: string, num: number): Promise<{ url: string; contextUrl?: string; domain?: string }[]> {
  const key = process.env.SERPER_KEY;
  if (!key) return [];
  try {
    const res = await trackedFetch("https://google.serper.dev/images", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { images?: SerperImg[] };
    return (json.images ?? [])
      .slice(0, num)
      .map((it) => ({ url: it.thumbnailUrl ?? it.imageUrl ?? "", contextUrl: it.link, domain: it.domain ?? hostOf(it.link) }))
      .filter((p) => p.url);
  } catch {
    return [];
  }
}

/**
 * SZEROKI „harvest" zdjęć z lokalu (BEZ per-danie): strona www (site:domena) + portale/social
 * (nazwa + miasto). Dedup po URL. Zwraca pulę + ślad zapytań (co poszło, ile wróciło).
 */
export async function harvestVenuePool(args: {
  domain?: string;
  name: string;
  city?: string;
  perQuery?: number;
}): Promise<{ photos: PoolPhoto[]; queries: HarvestQuery[] }> {
  const { domain, name, city, perQuery = 12 } = args;
  const queries: HarvestQuery[] = [];
  const photos: PoolPhoto[] = [];
  const seen = new Set<string>();
  const push = (list: { url: string; contextUrl?: string; domain?: string }[], source: PoolSource): void => {
    for (const p of list) {
      if (!p.url || seen.has(p.url)) continue;
      seen.add(p.url);
      photos.push({ source, url: p.url, contextUrl: p.contextUrl, domain: p.domain, nameInUrl: venueNameInUrl(p.contextUrl, name) });
    }
  };

  if (domain) {
    const q = `site:${domain}`;
    const r = await serperImages(q, perQuery).catch(() => []);
    queries.push({ label: `strona www (site:${domain})`, query: q, returned: r.length });
    push(r, "site");
  }

  const venueQual = [name, city].filter(Boolean).join(" ");
  const portalQ = `${venueQual} (${PORTALS.map((d) => `site:${d}`).join(" OR ")})`;
  const rp = await serperImages(portalQ, perQuery).catch(() => []);
  queries.push({ label: "portale/social", query: portalQ, returned: rp.length });
  push(rp, "portal");

  return { photos, queries };
}

export interface PoolResult extends PoolPhoto {
  category: "food" | "drink" | "other";
  /** Kanoniczna nazwa pozycji z menu (gdy dopasowano) albo '' (brak / nie z menu). */
  dish: string;
  confidence: number;
  realFood: boolean;
  stockOrAi: boolean;
}

type ImgMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
function mediaFromCt(ct: string): ImgMedia {
  return /png/.test(ct) ? "image/png" : /webp/.test(ct) ? "image/webp" : /gif/.test(ct) ? "image/gif" : "image/jpeg";
}
async function fetchB64(url: string): Promise<{ media_type: ImgMedia; data: string } | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "MenuButBetter/1.0 (venue harvest; rk@appwithkiss.com)" } });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > 4_500_000) return null;
    return { media_type: mediaFromCt(r.headers.get("content-type") || ""), data: buf.toString("base64") };
  } catch {
    return null;
  }
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

/** Etykieta źródła dla modelu — z informacją o sile dowodu „z tego lokalu". */
function sourceTag(p: PoolPhoto): string {
  if (p.source === "site") return "strona lokalu";
  if (p.source === "google") return "Google Maps";
  if (p.source === "tripadvisor") return "TripAdvisor";
  return p.nameInUrl ? "portal (nazwa lokalu w URL)" : "portal (niepewne źródło)";
}

const VENUE_SYSTEM =
  "Klasyfikujesz zdjęcia ZEBRANE z różnych źródeł o jednej restauracji i dopasowujesz realne " +
  "potrawy do pozycji z jej menu. Bezwzględnie oznaczasz stock/AI/render jako stock_or_ai=true.";

function instruction(dishes: string[], cuisine?: string, certain = true): string {
  const ctx = cuisine ? ` (kuchnia: ${cuisine})` : "";
  const origin = certain
    ? `Zdjęcia zebrano dla lokalu${ctx}. Część jest z PROFILU lokalu (Google Maps / TripAdvisor / strona www) — te są NA PEWNO z tego miejsca.\n`
    : `Zdjęcia zebrano dla lokalu${ctx}, ale dopasowanie lokalu jest NIEPEWNE.\n`;
  return (
    origin +
    "Każde zdjęcie ma w nawiasie ŹRÓDŁO. „strona lokalu”, „Google Maps”, „TripAdvisor” = mocny dowód, że to " +
    "TEN lokal. „portal (nazwa lokalu w URL)” = średni. „portal (niepewne źródło)” = SŁABY — może być cudze/generyczne.\n" +
    "Dla KAŻDEGO zdjęcia podaj: index, category (food/drink/other).\n" +
    "Jeśli food/drink → dopasuj do NAJBLIŻSZEJ pozycji z listy menu i zwróć jej DOKŁADNĄ nazwę (dish), albo '' gdy " +
    "nic nie pasuje; podaj confidence 0..1.\n" +
    "Gdy jedno zdjęcie pasuje do KILKU dań — wybierz najbardziej szczegółowo zgodne; nie przypisuj tego samego " +
    "zdjęcia do wielu różnych dań (lepiej '' niż na siłę).\n" +
    "Przy źródle „portal (niepewne źródło)” bądź OSTROŻNY: zaniżaj confidence, gdy zdjęcie może nie pochodzić z " +
    "tego lokalu.\n" +
    "Podpis [TripAdvisor] to MOCNA wskazówka nazwy dania.\n" +
    "real_food = czy to realne zdjęcie potrawy. stock_or_ai = stock / AI / studyjny render marketingowy " +
    "(dramatyczne światło, idealne tło) — takie ODRZUCAMY.\n" +
    "LISTA MENU:\n" +
    dishes.join(" | ")
  );
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          category: { type: "string", enum: ["food", "drink", "other"] },
          dish: { type: "string", description: "Dokładna nazwa z listy menu albo '' gdy nie pasuje." },
          confidence: { type: "number", description: "0..1 — pewność dopasowania do tej pozycji." },
          real_food: { type: "boolean", description: "Realne zdjęcie potrawy (nie render/stock/AI)." },
          stock_or_ai: { type: "boolean", description: "Wygląda na stock / AI / studyjny render." },
        },
        required: ["index", "category", "dish", "confidence", "real_food", "stock_or_ai"],
      },
    },
  },
  required: ["results"],
} as const;

/** Równomierne ograniczenie puli (round-robin po źródłach) do `cap` — każde źródło ma reprezentację. */
function capRoundRobin(pool: PoolPhoto[], cap: number): PoolPhoto[] {
  const order: PoolSource[] = ["site", "google", "tripadvisor", "portal"];
  const buckets = order.map((s) => pool.filter((p) => p.source === s));
  const out: PoolPhoto[] = [];
  const maxLen = Math.max(0, ...buckets.map((b) => b.length));
  for (let i = 0; i < maxLen && out.length < cap; i++)
    for (const b of buckets) {
      if (out.length >= cap) break;
      if (b[i]) out.push(b[i]!);
    }
  return out;
}

/**
 * JEDNO przejście vision: cała pula zdjęć (URL-e + Google Places) klasyfikowana naraz i dopasowana
 * do dań z menu. Zwraca werdykt dla KAŻDEGO zdjęcia (do oceny w LABie — nie filtrujemy), plus zużycie.
 */
export async function matchPoolToDishes(args: {
  pool: PoolPhoto[];
  dishes: string[];
  cuisine?: string;
  model?: string;
  certain?: boolean;
  cap?: number;
}): Promise<{ results: PoolResult[]; usage: Usage; fetched: number }> {
  const dishes = args.dishes.filter(Boolean);
  if (dishes.length === 0) return { results: [], usage: ZERO_USAGE, fetched: 0 };

  const pool = capRoundRobin(args.pool, args.cap ?? 24);

  // Pobierz bajty obrazów (URL → fetch; Google → fetchPlacePhoto). Nieudane pomijamy.
  type Loaded = { meta: PoolPhoto; img: { media_type: ImgMedia; data: string } };
  const loaded: Loaded[] = [];
  await Promise.all(
    pool.map(async (p) => {
      if (p.source === "google" && p.photoName) {
        try {
          const { body, contentType } = await fetchPlacePhoto(p.photoName, 800);
          loaded.push({ meta: p, img: { media_type: mediaFromCt(contentType), data: Buffer.from(body).toString("base64") } });
        } catch {
          /* pomiń */
        }
      } else if (p.url) {
        const img = await fetchB64(p.url);
        if (img) loaded.push({ meta: p, img });
      }
    }),
  );
  if (loaded.length === 0) return { results: [], usage: ZERO_USAGE, fetched: 0 };

  const byNorm = new Map<string, string>();
  for (const d of dishes) byNorm.set(norm(d), d);

  const model = args.model || MODEL;
  const isOpenAI = usesOpenAiApi(model);
  recordBytes(apiTag(model), loaded.reduce((n, it) => n + it.img.data.length, 0), 0);
  const instr = instruction(dishes, args.cuisine, args.certain !== false);

  let jsonText: string | null = null;
  let usage: Usage = ZERO_USAGE;
  try {
    if (isOpenAI) {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      loaded.forEach((it, i) => {
        const cap = it.meta.caption ? ` podpis:"${it.meta.caption}"` : "";
        content.push({ type: "text", text: `Zdjęcie ${i} [${sourceTag(it.meta)}]${cap}` });
        content.push({ type: "image_url", image_url: { url: `data:${it.img.media_type};base64,${it.img.data}` } });
      });
      content.push({ type: "text", text: instr });
      const r = await openaiVisionJson({ op: "venue-harvest", model, system: VENUE_SYSTEM, content, schemaName: "venue_matches", schema: SCHEMA as unknown as Record<string, unknown>, maxCompletionTokens: 3500 });
      jsonText = r.json;
      usage = r.usage;
    } else {
      const content: Anthropic.ContentBlockParam[] = [];
      loaded.forEach((it, i) => {
        const cap = it.meta.caption ? ` podpis:"${it.meta.caption}"` : "";
        content.push({ type: "text", text: `Zdjęcie ${i} [${sourceTag(it.meta)}]${cap}` });
        content.push({ type: "image", source: { type: "base64", media_type: it.img.media_type, data: it.img.data } });
      });
      content.push({ type: "text", text: instr });
      const resp = await track("claude", "venue-harvest", () =>
        client.messages.create({ model, max_tokens: 2500, system: VENUE_SYSTEM, messages: [{ role: "user", content }], output_config: { format: { type: "json_schema", schema: SCHEMA } } }),
      );
      usage = usageFrom(model, resp.usage);
      recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd, model);
      const text = resp.content.find((b) => b.type === "text");
      jsonText = text && text.type === "text" ? text.text : null;
    }
  } catch {
    return { results: [], usage: ZERO_USAGE, fetched: loaded.length };
  }

  if (!jsonText) return { results: [], usage, fetched: loaded.length };
  let parsed: { results: { index: number; category: string; dish: string; confidence: number; real_food: boolean; stock_or_ai: boolean }[] };
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { results: [], usage, fetched: loaded.length };
  }

  const results: PoolResult[] = [];
  for (const r of parsed.results) {
    const it = loaded[r.index];
    if (!it) continue;
    const canon = byNorm.get(norm(r.dish || "")) || "";
    results.push({
      ...it.meta,
      category: (r.category === "food" || r.category === "drink") ? r.category : "other",
      dish: canon,
      confidence: Math.max(0, Math.min(1, r.confidence)),
      realFood: !!r.real_food,
      stockOrAi: !!r.stock_or_ai,
    });
  }
  results.sort((a, b) => b.confidence - a.confidence);
  return { results, usage, fetched: loaded.length };
}

/** Czy werdykt to AKCEPTOWANE dopasowanie (te same reguły co Tier 0: jedzenie, realne, nie stock, próg). */
export function poolMatchAccepted(r: PoolResult): boolean {
  return (r.category === "food" || r.category === "drink") && r.realFood && !r.stockOrAi && !!r.dish && r.confidence >= MATCH_MIN;
}
