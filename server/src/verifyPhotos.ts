// Weryfikacja zdjęć dania przez Claude vision: NA ILE zdjęcie przedstawia danie (0..1).
// Model: Sonnet — na danych testowych (Cúrcuma/Badalona) dorównuje Opusowi w odsiewaniu
// chybionych zdjęć, a jest szybszy/tańszy. Haiku ODRZUCONY: dawał fałszywe trafienia
// (np. 0.85 dla pakory zwróconej na zapytanie „Mango Lassi").
import Anthropic from "@anthropic-ai/sdk";
import { usageFrom, ZERO_USAGE, type Usage } from "./usage.ts";
import { track } from "./apiLog.ts";

const client = new Anthropic();
const MODEL = "claude-sonnet-4-6";

// Próg akceptacji: zdjęcie pokazujemy jako „z lokalu" tylko, gdy model jest pewny, że to
// danie (lub bardzo podobne tego samego typu). Poniżej — wolimy czyste zdjęcie POGLĄDOWE
// (typ dania) niż przypadkowe zdjęcie z portalu. Dobrane na audycie: trafione ≥0.6,
// generyczny szum (zestawy, wnętrza, napoje) ≤0.45.
export const MATCH_THRESHOLD = 0.6;

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
        },
        required: ["index", "match"],
      },
    },
  },
  required: ["results"],
} as const;

export interface ScoreOptions {
  /** Kontekst kuchni (np. „indyjska") — poprawia trafność oceny. */
  cuisine?: string;
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

/** Zwraca oceny 0..1 (zrównane z `urls`) + zużycie tokenów weryfikacji. */
export async function scoreDishPhotos(
  dish: string,
  urls: string[],
  opts: ScoreOptions = {},
): Promise<{ scores: number[]; usage: Usage }> {
  if (urls.length === 0) return { scores: [], usage: ZERO_USAGE };
  const scores = new Array<number>(urls.length).fill(0);
  let usage: Usage = ZERO_USAGE;

  // Pobierz wszystkie miniaturki równolegle (base64). Nieudane pomijamy — zostaną z oceną 0.
  const imgs = await Promise.all(urls.map((u) => fetchImageB64(u)));
  const content: Anthropic.ContentBlockParam[] = [];
  urls.forEach((_, i) => {
    const im = imgs[i];
    if (!im) return; // nie udało się pobrać — index dostanie 0
    content.push({ type: "text", text: `Zdjęcie ${i}` });
    content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
  });
  // Nic się nie pobrało → nie ma czego oceniać.
  if (!content.some((b) => b.type === "image")) return { scores, usage: ZERO_USAGE };

  const ctx = opts.cuisine ? ` (kuchnia: ${opts.cuisine})` : "";
  content.push({
    type: "text",
    text:
      `Oceniasz, czy zdjęcie pokazuje pozycję z menu: „${dish}"${ctx} — faktyczne podane JEDZENIE albo NAPÓJ.\n` +
      "Dla KAŻDEGO zdjęcia podaj index oraz match w skali 0..1.\n" +
      "match=0.0, gdy zdjęcie NIE przedstawia tej pozycji ani niczego podobnego tego samego typu, w szczególności:\n" +
      "- tekst / karta menu / jadłospis / dokument / szyld / paragon / cennik / ekran (nawet z nazwą dania),\n" +
      "- mapa, wykres, rysunek, schemat, logo, grafika, ikona,\n" +
      "- budynek / fasada / wnętrze / ludzie / zwierzę / roślina / krajobraz / przedmiot niezwiązany z jedzeniem,\n" +
      "- INNA potrawa lub napój niż opisany (np. curry/chleb, gdy pozycja to woda lub napój gazowany).\n" +
      "match>0.8 TYLKO, gdy wyraźnie widać właśnie tę pozycję (to danie albo ten napój).\n" +
      "match 0.4–0.7, gdy to jedzenie/napój wyraźnie tego samego typu, ale nie wprost ta pozycja.",
  });

  try {
    const resp = await track("claude", "verify-photos", () =>
      client.messages.create({
      model: MODEL,
      max_tokens: 800,
      system:
        "Jesteś ekspertem oceniającym, czy zdjęcie przedstawia konkretną pozycję z menu " +
        "(jedzenie lub napój). Bezwzględnie odrzucasz wszystko, co nią nie jest: tekst, karty menu, " +
        "mapy, rysunki, logo, budynki, wnętrza, ludzi, zwierzęta, przedmioty oraz inne dania/napoje.",
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    );
    usage = usageFrom(MODEL, resp.usage);
    const text = resp.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return { scores, usage };
    const parsed = JSON.parse(text.text) as { results: { index: number; match: number }[] };
    for (const r of parsed.results) {
      if (r.index >= 0 && r.index < scores.length) {
        scores[r.index] = Math.max(0, Math.min(1, r.match));
      }
    }
  } catch {
    // Błąd weryfikacji → zera: nic nie przejdzie progu, więc spadniemy na zdjęcia
    // poglądowe (bezpieczniej pokazać „przykład" niż przypadkowe zdjęcie).
  }
  return { scores, usage };
}
