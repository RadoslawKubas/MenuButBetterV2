// Weryfikacja zdjęć dania przez Claude vision: NA ILE zdjęcie przedstawia danie (0..1).
// Model: Sonnet — na danych testowych (Cúrcuma/Badalona) dorównuje Opusowi w odsiewaniu
// chybionych zdjęć, a jest szybszy/tańszy. Haiku ODRZUCONY: dawał fałszywe trafienia
// (np. 0.85 dla pakory zwróconej na zapytanie „Mango Lassi").
import Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { usageFrom, ZERO_USAGE, type Usage } from "./usage.ts";
import { track, recordUsage, recordBytes } from "./apiLog.ts";
import { openaiVisionJson } from "./openaiClient.ts";
import { usesOpenAiApi, apiTag } from "./models.ts";
import { cacheGet, cacheSet, cacheKey } from "./cache.ts";

const client = new Anthropic({ maxRetries: 4 });
const MODEL = "claude-sonnet-4-6"; // domyślny model weryfikacji (gdy nie podano innego)

// Wpisuje oceny + flagę „wpalony tekst" z JSON-a modelu (po indeksie zdjęcia).
function applyScores(jsonText: string, scores: number[], textOverlay: boolean[]): void {
  try {
    const parsed = JSON.parse(jsonText) as { results: { index: number; match: number; text_overlay?: boolean }[] };
    for (const r of parsed.results) {
      if (r.index >= 0 && r.index < scores.length) {
        scores[r.index] = Math.max(0, Math.min(1, r.match));
        textOverlay[r.index] = !!r.text_overlay;
      }
    }
  } catch {
    /* niepoprawny JSON — zostają zera */
  }
}

// Próg akceptacji: zdjęcie pokazujemy jako „z lokalu" tylko, gdy model jest pewny, że to
// danie (lub bardzo podobne tego samego typu). Poniżej — wolimy czyste zdjęcie POGLĄDOWE
// (typ dania) niż przypadkowe zdjęcie z portalu. Dobrane na audycie: trafione ≥0.6,
// generyczny szum (zestawy, wnętrza, napoje) ≤0.45.
export const MATCH_THRESHOLD = 0.6;

export const VERIFY_SYSTEM =
  "Jesteś ekspertem oceniającym, czy zdjęcie przedstawia konkretną pozycję z menu " +
  "(jedzenie lub napój). Bezwzględnie odrzucasz wszystko, co nią nie jest: tekst, karty menu, " +
  "mapy, rysunki, logo, budynki, wnętrza, ludzi, zwierzęta, przedmioty oraz inne dania/napoje.";

export function verifyInstruction(dish: string, cuisine?: string): string {
  const ctx = cuisine ? ` (kuchnia: ${cuisine})` : "";
  return (
    `Oceniasz, czy zdjęcie pokazuje pozycję z menu: „${dish}"${ctx} — faktyczne podane JEDZENIE albo NAPÓJ.\n` +
    "Dla KAŻDEGO zdjęcia podaj index oraz match w skali 0..1.\n" +
    "match=0.0, gdy zdjęcie NIE przedstawia tej pozycji ani niczego podobnego tego samego typu, w szczególności:\n" +
    "- tekst / karta menu / jadłospis / dokument / szyld / paragon / cennik / ekran (nawet z nazwą dania),\n" +
    "- mapa, wykres, rysunek, schemat, logo, grafika, ikona,\n" +
    "- budynek / fasada / wnętrze / ludzie / zwierzę / roślina / krajobraz / przedmiot niezwiązany z jedzeniem,\n" +
    "- INNA potrawa lub napój niż opisany (np. curry/chleb, gdy pozycja to woda lub napój gazowany).\n" +
    "match>0.8 TYLKO, gdy wyraźnie widać właśnie tę pozycję (to danie albo ten napój).\n" +
    "match 0.4–0.7, gdy to jedzenie/napój wyraźnie tego samego typu, ale nie wprost ta pozycja.\n" +
    "Dodatkowo ustaw text_overlay=true, gdy na zdjęciu jest WPALONY tekst/napis (tytuł dania, " +
    "logo przepisu, baner, kolaż z podpisem — typowe piny z blogów/Pinteresta) — chcemy czyste " +
    "zdjęcia jedzenia; w przeciwnym razie false."
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
          match: { type: "number", description: "0..1 — jak pewnie zdjęcie przedstawia to danie." },
          text_overlay: { type: "boolean", description: "true = wpalony tekst/napis na zdjęciu (pin/przepis)." },
        },
        required: ["index", "match", "text_overlay"],
      },
    },
  },
  required: ["results"],
} as const;

export interface ScoreOptions {
  /** Kontekst kuchni (np. „indyjska") — poprawia trafność oceny. */
  cuisine?: string;
  /** Model weryfikacji (Claude lub GPT). Domyślnie Sonnet. */
  model?: string;
  /** Pomiń cache werdyktów (LAB / porównania modeli). */
  noCache?: boolean;
}

type ImgMedia = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

// Pobiera obrazek SAMODZIELNIE i koduje base64. KONIECZNE: Claude przez `url` nie potrafi
// ściągnąć części źródeł (np. Wikimedia blokuje fetcher Anthropic → 400) — wtedy cała
// weryfikacja padała i wszystko było odrzucane. Pobranie po naszej stronie to omija.
async function fetchImageB64(url: string): Promise<{ media_type: ImgMedia; data: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MenuButBetter/1.0 (dish photo verifier; contact rk@appwithkiss.com)" },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    const media_type: ImgMedia = /png/.test(ct)
      ? "image/png"
      : /webp/.test(ct)
        ? "image/webp"
        : /gif/.test(ct)
          ? "image/gif"
          : "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 4_500_000) return null;
    return { media_type, data: buf.toString("base64") };
  } catch {
    return null;
  }
}

/** Zwraca oceny 0..1 + flagi „wpalony tekst" (zrównane z `urls`) + zużycie tokenów weryfikacji. */
export async function scoreDishPhotos(
  dish: string,
  urls: string[],
  opts: ScoreOptions = {},
): Promise<{ scores: number[]; textOverlay: boolean[]; usage: Usage }> {
  if (urls.length === 0) return { scores: [], textOverlay: [], usage: ZERO_USAGE };
  const model = opts.model || MODEL;
  const isOpenAI = usesOpenAiApi(model); // OpenAI lub Gemini → ścieżka OpenAI-compatible
  const scores = new Array<number>(urls.length).fill(0);
  const textOverlay = new Array<boolean>(urls.length).fill(false);

  // ③ CACHE werdyktów vision per (termin, URL): to samo zdjęcie ocenione już dla tego dania/kuchni/
  // modelu → bierzemy z cache i NIE wysyłamy go do modelu (oszczędza vision — główny koszt).
  const useCache = !opts.noCache;
  const vck = (u: string) => cacheKey("vision-url", dish, opts.cuisine, model, u);
  const need: number[] = [];
  if (useCache) {
    await Promise.all(urls.map(async (u, i) => {
      const hit = await cacheGet<{ m: number; t: boolean }>("vision-url", vck(u), { op: "verify-photos" });
      if (hit) { scores[i] = hit.m; textOverlay[i] = !!hit.t; } else need.push(i);
    }));
  } else {
    for (let i = 0; i < urls.length; i++) need.push(i);
  }
  if (need.length === 0) return { scores, textOverlay, usage: ZERO_USAGE }; // całość z cache

  // Pobierz TYLKO niezcache’owane miniaturki (base64). Nieudane pomijamy — zostaną z oceną 0.
  const imgs = new Array<{ media_type: ImgMedia; data: string } | null>(urls.length).fill(null);
  await Promise.all(need.map(async (i) => { imgs[i] = await fetchImageB64(urls[i]!); }));
  const valid = need.filter((i) => imgs[i]);
  if (valid.length === 0) return { scores, textOverlay, usage: ZERO_USAGE };
  // Zapis ocen do cache (po udanej weryfikacji) — woła się przed zwrotem.
  const persist = () => { if (useCache) for (const i of valid) void cacheSet("vision-url", vck(urls[i]!), { m: scores[i]!, t: textOverlay[i]! }); };

  // Ruch: pobranie zdjęć z sieci (recv) + relay tych zdjęć do AI (sent ≈ base64).
  const sentBytes = valid.reduce((n, i) => n + imgs[i]!.data.length, 0);
  recordBytes("other", 0, Math.round(sentBytes * 0.75)); // pobrane z webu (decoded ≈ 3/4 base64)
  recordBytes(apiTag(model), sentBytes, 0); // relay do modelu wizji

  const instruction = verifyInstruction(dish, opts.cuisine);
  const system = VERIFY_SYSTEM;

  try {
    if (isOpenAI) {
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      valid.forEach((i) => {
        const im = imgs[i]!;
        content.push({ type: "text", text: `Zdjęcie ${i}` });
        content.push({ type: "image_url", image_url: { url: `data:${im.media_type};base64,${im.data}` } });
      });
      content.push({ type: "text", text: instruction });
      const { json, usage } = await openaiVisionJson({
        op: "verify-photos",
        model,
        system,
        content,
        schemaName: "scores",
        schema: SCHEMA as unknown as Record<string, unknown>,
      });
      if (json) applyScores(json, scores, textOverlay);
      persist();
      return { scores, textOverlay, usage };
    }

    const content: Anthropic.ContentBlockParam[] = [];
    valid.forEach((i) => {
      const im = imgs[i]!;
      content.push({ type: "text", text: `Zdjęcie ${i}` });
      content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
    });
    content.push({ type: "text", text: instruction });
    const resp = await track("claude", "verify-photos", () =>
      client.messages.create({
        model,
        max_tokens: 800,
        // ⑤ Prompt caching SYSTEM (Anthropic) — taniej input przy seriach weryfikacji w 5 min.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    );
    const usage = usageFrom(model, resp.usage);
    recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd, model);
    const text = resp.content.find((b) => b.type === "text");
    if (text && text.type === "text") applyScores(text.text, scores, textOverlay);
    persist();
    return { scores, textOverlay, usage };
  } catch {
    // Błąd weryfikacji → zera: nic nie przejdzie progu, więc spadniemy na zdjęcia
    // poglądowe (bezpieczniej pokazać „przykład" niż przypadkowe zdjęcie).
    return { scores, textOverlay, usage: ZERO_USAGE };
  }
}
