// Tier 0 — „pula z lokalu, dopasowana wizją". Najmocniejsze źródło PRAWDZIWYCH zdjęć dań
// z konkretnej restauracji (wgrane przez ludzi do tego miejsca): Google Places + TripAdvisor.
// Jedno przejście Claude vision klasyfikuje całą pulę, dopasowuje jedzenie do pozycji z menu
// i ODRZUCA stock/AI/marketing. Eksperymenty (Cúrcuma, Khan Nawab) potwierdziły 8–10 trafień
// na lokal przy 1 wywołaniu wizji — taniej i lepiej niż wyszukiwanie per‑danie.
import Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { fetchPlacePhoto } from "./places.ts";
import { usageFrom, ZERO_USAGE, type Usage } from "./usage.ts";
import { track, recordUsage, recordBytes } from "./apiLog.ts";
import { openaiVisionJson } from "./openaiClient.ts";
import { usesOpenAiApi, apiTag } from "./models.ts";

const client = new Anthropic({ maxRetries: 4 });
const MODEL = "claude-sonnet-4-6"; // domyślny model dopasowania (gdy nie podano innego)

// Próg pewności dopasowania danie↔zdjęcie. Niżej — zbyt luźne (ryzyko złego dania).
const MATCH_MIN = 0.5;

export const VENUE_SYSTEM =
  "Klasyfikujesz zdjęcia z profilu restauracji i dopasowujesz realne potrawy do pozycji menu. " +
  "Bezwzględnie oznaczasz stock/AI/render jako stock_or_ai=true.";

// `certain` = lokal pewny (nazwa potwierdzona w Places, nie zgadnięty po GPS). Gdy niepewny,
// NIE twierdzimy „na pewno z tego miejsca" i każemy modelowi odrzucać zdjęcia niepasujące do
// kuchni/charakteru — bo pula może być z innego lokalu (zwrócona jako „najbliższy strzał").
export function venueInstruction(dishes: string[], cuisine?: string, certain = true): string {
  const ctx = cuisine ? ` (kuchnia: ${cuisine})` : "";
  const origin = certain
    ? `To zdjęcia z profilu lokalu (Google Maps / TripAdvisor)${ctx} — NA PEWNO z tego miejsca.\n`
    : `To zdjęcia z profilu lokalu (Google Maps / TripAdvisor)${ctx}, ale dopasowanie lokalu jest NIEPEWNE — ` +
      `pula może pochodzić z INNEGO miejsca. Bądź rygorystyczny: ODRZUCAJ (dish='', confidence niskie) zdjęcia, ` +
      `które nie pasują do tej kuchni/charakteru menu.\n`;
  return (
    origin +
    "Dla KAŻDEGO zdjęcia podaj: index, category (food/drink/other).\n" +
    "Jeśli food/drink → dopasuj do NAJBLIŻSZEJ pozycji z poniższej listy menu i zwróć jej DOKŁADNĄ nazwę " +
    "(dish), albo '' gdy nic nie pasuje; podaj confidence 0..1.\n" +
    "Gdy jedno zdjęcie pasuje do KILKU dań — wybierz NAJBARDZIEJ szczegółowo zgodne; nie przypisuj tego " +
    "samego zdjęcia do wielu różnych dań (lepiej '' niż na siłę).\n" +
    "Podpis [TripAdvisor] to MOCNA wskazówka nazwy dania.\n" +
    "real_food = czy to realne zdjęcie potrawy. stock_or_ai = czy wygląda na stock / AI / studyjny render " +
    "marketingowy (dramatyczne światło, idealne tło, render) — takie ODRZUCAMY.\n" +
    "LISTA MENU:\n" +
    dishes.join(" | ")
  );
}

export interface VenueTaPhoto {
  url: string;
  caption: string | null;
}

export interface VenueMatch {
  /** Dokładna nazwa pozycji z menu (oryginalna). */
  dish: string;
  source: "google" | "tripadvisor";
  /** Google: nazwa zasobu zdjęcia (klient buduje proxy URL). */
  photoName?: string;
  /** TripAdvisor: bezpośredni URL. */
  url?: string;
  caption: string | null;
  confidence: number;
}

export interface VenuePhotosInput {
  photoNames: string[];
  taPhotos: VenueTaPhoto[];
  dishes: string[];
  cuisine?: string;
  /** Model dopasowania (Claude lub GPT). Domyślnie Sonnet. */
  model?: string;
  /** Czy lokal jest PEWNY (nazwa potwierdzona, nie zgadnięty po GPS). Domyślnie true.
   *  false → ostrożniejsza instrukcja (odrzucaj zdjęcia niepasujące do kuchni). */
  certain?: boolean;
}

type ImgMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function mediaFromCt(ct: string): ImgMedia {
  return /png/.test(ct) ? "image/png" : /webp/.test(ct) ? "image/webp" : /gif/.test(ct) ? "image/gif" : "image/jpeg";
}

async function fetchB64(url: string): Promise<{ media_type: ImgMedia; data: string } | null> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "MenuButBetter/1.0 (venue photo matcher; rk@appwithkiss.com)" },
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > 4_500_000) return null;
    return { media_type: mediaFromCt(r.headers.get("content-type") || ""), data: buf.toString("base64") };
  } catch {
    return null;
  }
}

// Normalizacja nazwy dania do dopasowania tego, co zwróci model, z listą menu.
function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
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
          stock_or_ai: { type: "boolean", description: "Wygląda na stock / AI / studyjny render marketingowy." },
        },
        required: ["index", "category", "dish", "confidence", "real_food", "stock_or_ai"],
      },
    },
  },
  required: ["results"],
} as const;

/**
 * Pobiera pulę zdjęć lokalu (Google Places + TripAdvisor), jednym przejściem wizji
 * dopasowuje jedzenie do dań z menu (z odrzuceniem stock/AI) i zwraca ★ dopasowania.
 */
export async function matchVenuePhotos(
  input: VenuePhotosInput,
): Promise<{ matches: VenueMatch[]; usage: Usage }> {
  const dishes = input.dishes.filter(Boolean);
  if (dishes.length === 0) return { matches: [], usage: ZERO_USAGE };

  // Zbierz obrazy (z metadanymi pozwalającymi później zbudować URL).
  type Item = {
    source: "google" | "tripadvisor";
    photoName?: string;
    url?: string;
    caption: string | null;
    img: { media_type: ImgMedia; data: string };
  };
  const items: Item[] = [];

  await Promise.all(
    input.photoNames.slice(0, 10).map(async (name) => {
      try {
        const { body, contentType } = await fetchPlacePhoto(name, 800);
        items.push({
          source: "google",
          photoName: name,
          caption: null,
          img: { media_type: mediaFromCt(contentType), data: Buffer.from(body).toString("base64") },
        });
      } catch {
        // pomiń zdjęcie, którego nie da się pobrać
      }
    }),
  );
  await Promise.all(
    input.taPhotos.slice(0, 20).map(async (p) => {
      const img = await fetchB64(p.url);
      if (img) items.push({ source: "tripadvisor", url: p.url, caption: p.caption, img });
    }),
  );

  if (items.length === 0) return { matches: [], usage: ZERO_USAGE };

  // Mapa znormalizowana → kanoniczna nazwa z menu (do walidacji odpowiedzi modelu).
  const byNorm = new Map<string, string>();
  for (const d of dishes) byNorm.set(norm(d), d);

  const model = input.model || MODEL;
  const isOpenAI = usesOpenAiApi(model); // OpenAI lub Gemini → ścieżka OpenAI-compatible
  // Relay całej puli zdjęć lokalu do AI (sent ≈ base64). Pobranie z Google idzie przez trackedFetch.
  recordBytes(apiTag(model), items.reduce((n, it) => n + it.img.data.length, 0), 0);
  const instruction = venueInstruction(dishes, input.cuisine, input.certain !== false);
  const system = VENUE_SYSTEM;

  try {
    let jsonText: string | null = null;
    let usage: Usage = ZERO_USAGE;

    if (isOpenAI) {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      items.forEach((it, i) => {
        const cap = it.caption ? ` podpis:"${it.caption}"` : "";
        content.push({ type: "text", text: `Zdjęcie ${i} [${it.source}]${cap}` });
        content.push({ type: "image_url", image_url: { url: `data:${it.img.media_type};base64,${it.img.data}` } });
      });
      content.push({ type: "text", text: instruction });
      const r = await openaiVisionJson({
        op: "venue-photos",
        model,
        system,
        content,
        schemaName: "venue_matches",
        schema: SCHEMA as unknown as Record<string, unknown>,
        maxCompletionTokens: 3000,
      });
      jsonText = r.json;
      usage = r.usage;
    } else {
      const content: Anthropic.ContentBlockParam[] = [];
      items.forEach((it, i) => {
        const cap = it.caption ? ` podpis:"${it.caption}"` : "";
        content.push({ type: "text", text: `Zdjęcie ${i} [${it.source}]${cap}` });
        content.push({ type: "image", source: { type: "base64", media_type: it.img.media_type, data: it.img.data } });
      });
      content.push({ type: "text", text: instruction });
      const resp = await track("claude", "venue-photos", () =>
        client.messages.create({
          model,
          max_tokens: 2000,
          system,
          messages: [{ role: "user", content }],
          output_config: { format: { type: "json_schema", schema: SCHEMA } },
        }),
      );
      usage = usageFrom(model, resp.usage);
      recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd, model);
      const text = resp.content.find((b) => b.type === "text");
      jsonText = text && text.type === "text" ? text.text : null;
    }

    if (!jsonText) return { matches: [], usage };
    const parsed = JSON.parse(jsonText) as {
      results: { index: number; category: string; dish: string; confidence: number; real_food: boolean; stock_or_ai: boolean }[];
    };

    const matches: VenueMatch[] = [];
    for (const r of parsed.results) {
      const it = items[r.index];
      if (!it) continue;
      if (r.category !== "food" && r.category !== "drink") continue;
      if (!r.real_food || r.stock_or_ai) continue; // odrzuć stock/AI
      if (r.confidence < MATCH_MIN) continue;
      const canon = byNorm.get(norm(r.dish || ""));
      if (!canon) continue; // model zwrócił coś spoza menu
      matches.push({
        dish: canon,
        source: it.source,
        photoName: it.photoName,
        url: it.url,
        caption: it.caption,
        confidence: Math.max(0, Math.min(1, r.confidence)),
      });
    }
    // Najpewniejsze pierwsze (klient grupuje po daniu).
    matches.sort((a, b) => b.confidence - a.confidence);
    return { matches, usage };
  } catch {
    return { matches: [], usage: ZERO_USAGE };
  }
}
