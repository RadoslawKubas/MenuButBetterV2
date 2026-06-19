// Rdzeń: jedno lub WIELE zdjęć menu → vision (Claude lub OpenAI) → jedno spójne menu.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { MENU_SCHEMA, type Menu } from "./schema.ts";
import { usageFrom, usageFromOpenAI, logUsage, type Usage } from "./usage.ts";
import { track, recordUsage, recordBytes } from "./apiLog.ts";
import { MODELS, DEFAULT_MODEL, isModelId, usesOpenAiApi, apiTag, type ModelId } from "./models.ts";
import { getClientForModel } from "./openaiClient.ts";

// Rejestr modeli + walidator współdzielone z resztą serwera (re-eksport z models.ts).
export { MODELS, DEFAULT_MODEL, isModelId, type ModelId };

const client = new Anthropic({ maxRetries: 4 }); // klucz z ANTHROPIC_API_KEY (env); retry na sieć/429/5xx

export type MediaType = "image/jpeg" | "image/png" | "image/webp";

export interface InputImage {
  base64: string;
  mediaType: MediaType;
}

const MEDIA_TYPES: Record<string, MediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function mediaTypeFor(path: string): MediaType {
  const type = MEDIA_TYPES[extname(path).toLowerCase()];
  if (!type) throw new Error(`Nieobsługiwany format obrazu: ${path} (użyj jpg/png/webp)`);
  return type;
}

export interface ExtractOptions {
  /** Język docelowy tłumaczenia, np. "polski". */
  targetLang: string;
  /** Podpowiedź o lokalu (nazwa/miasto), jeśli znana — poprawia kontekst. */
  restaurantHint?: string;
  /** „Miasto, Kraj" z GPS (EXIF/telefon) — pewny kontekst lokalizacji lokalu. */
  locationHint?: string;
  /** Wstępnie rozpoznana kuchnia (z „szybkiego podglądu") — mocna wskazówka kontekstu. */
  cuisineHint?: string;
  /** Model do użycia. Domyślnie Sonnet 4.6. */
  model?: ModelId;
  /** Postęp odczytu na żywo (Claude, streaming): ile pozycji już wypisał model i ile znaków.
   *  Pozwala apce pokazać „Odczytano N pozycji…" zamiast samego licznika czasu. */
  onProgress?: (p: { chars: number; items: number }) => void;
  /** Każda sparsowana pozycja (nazwa + photo_query) NA ŻYWO ze strumienia — apka pokazuje nazwy
   *  i od razu dociąga dla nich tanie zdjęcia poglądowe (gotowe, zanim skan się skończy). */
  onItem?: (item: ScanItemStub) => void;
}

/** Minimalna pozycja wyłuskana ze strumienia — do podglądu nazw i wczesnego dociągania zdjęć. */
export interface ScanItemStub {
  original: string;
  translated: string;
  photoQuery: string;
  photoQueryLocal: string;
  branded: boolean;
}

// Wyłuskuje KOMPLETNE pozycje z (jeszcze niepełnego) strumienia JSON — po stałej kolejności pól
// schematu (original→translated→photo_query→photo_query_local→branded). Emituje tylko NOWE.
const ITEM_RE =
  /"original"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"translated"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"photo_query"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"photo_query_local"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"branded"\s*:\s*(true|false)/g;
function emitNewItems(text: string, state: { emitted: number }, onItem: (i: ScanItemStub) => void): void {
  const dec = (s: string) => {
    try {
      return JSON.parse(`"${s}"`) as string;
    } catch {
      return s;
    }
  };
  ITEM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = ITEM_RE.exec(text))) {
    if (idx >= state.emitted) {
      onItem({ original: dec(m[1]!), translated: dec(m[2]!), photoQuery: dec(m[3]!), photoQueryLocal: dec(m[4]!), branded: m[5] === "true" });
      state.emitted = idx + 1;
    }
    idx++;
  }
}

export const SYSTEM = [
  "Jesteś ekspertem kulinarnym i tłumaczem.",
  "Otrzymasz jedno lub WIELE zdjęć — to kolejne strony / fragmenty TEGO SAMEGO menu",
  "(mogą zawierać okładkę albo zdjęcie lokalu).",
  "Połącz wszystkie zdjęcia w JEDNO spójne menu: zachowaj kolejność sekcji w miarę,",
  "jak pojawiają się na stronach, i nie duplikuj powtórzonych nagłówków ani pozycji.",
  "Wyodrębnij WSZYSTKIE pozycje z podziałem na sekcje.",
  "",
  "NAJPIERW ustal kontekst i zapisz go w polu `cuisine`: rodzaj kuchni (np. indyjska,",
  "hiszpańska, włoska) oraz — na własny użytek — kraj i miasto lokalu (z nazw dań,",
  "języka menu, adresu i szyldu). Wszystkie opisy MUSZĄ pasować do tego kontekstu.",
  "Jeśli w treści podano `Lokalizacja lokalu (GPS)`, traktuj ją jako WIARYGODNE miejsce",
  "lokalu (kraj/miasto) — użyj jej do kontekstu i interpretacji lokalnych/regionalnych nazw",
  "dań, nawet jeśli menu jest w innym języku (kuchnia może być inna niż kraj położenia).",
  "",
  "Tłumacz nazwy i sekcje na język docelowy podany przez użytkownika.",
  "OPIS dania pisz ZWIĘŹLE i RZECZOWO, opierając się WYŁĄCZNIE na tym, co wynika z nazwy",
  "dania i z typowego sposobu jego przyrządzania w TEJ kuchni/regionie.",
  "NIE upiększaj i NIE dodawaj składników, których nie ma w nazwie i które nie są standardowe",
  "dla tego dania w tej kuchni (np. NIE dodawaj awokado do zwykłej zielonej sałatki",
  "w hinduskiej restauracji). Przy ogólnej nazwie (np. zielona sałatka) opisz typowy,",
  "prosty skład dla takiego lokalu, bez egzotycznych dodatków.",
  "Zasada: lepiej napisać ogólnie i PRAWDZIWIE niż barwnie i zmyślnie. W polu `ingredients`",
  "podawaj tylko składniki pewne lub typowe dla tego dania; nie zgaduj egzotycznych.",
  "Alergeny i flagi dietetyczne szacuj zachowawczo.",
  "",
  "Dla pola `photo_query` podaj KANONICZNĄ nazwę dania do szukania zdjęć — najlepiej rozpoznawalną",
  "nazwę potrawy w jej własnej kuchni (zromanizowaną), z dopisanym typem/kuchnią dla jednoznaczności",
  "(np. 'mango chicken curry indian', 'pad thai noodles', 'patatas bravas'). Opisz CZYM danie jest,",
  "nie markową/lokalną nazwą z menu — to poprawia trafianie w zdjęcie przy szukaniu ogólnym.",
  "Dla pola `photo_query_local` podaj nazwę dania do szukania zdjęć W JĘZYKU KRAJU, w którym jest",
  "lokal (kraj z lokalizacji/kontekstu) — tak jak ludzie szukają tego dania w tym kraju. Gdy język",
  "menu = język kraju, zwykle = original; gdy menu jest w innym języku (np. po angielsku, a lokal",
  "w Polsce), podaj nazwę w języku kraju (np. 'kurczak maślany'). Gdy się nie da — powtórz photo_query.",
  "Pole `branded` ustaw na true dla markowych/paczkowanych produktów o znanym, stałym wyglądzie",
  "(Coca-Cola, Sprite, Fanta, butelkowana woda, gotowy batonik) — wtedy lepsze jest generyczne",
  "zdjęcie produktu niż zdjęcie z lokalu. Dla potraw przyrządzanych w kuchni ustaw false.",
  "",
  "Jedno ze zdjęć może być FOTOGRAFIĄ LOKALU Z ZEWNĄTRZ (szyld, witryna, fasada) albo",
  "wnętrza — odczytaj NAZWĘ i adres także z szyldu/witryny. Takie zdjęcie zwykle nie",
  "zawiera dań: użyj go tylko do nazwy/adresu, nie twórz z niego pozycji menu.",
  "Nazwę i adres wyodrębnij do pól restaurant_name / restaurant_address (z okładki,",
  "nagłówka, stopki lub szyldu); jeśli nigdzie nie widać — ustaw null.",
  "Nie wymyślaj pozycji, których nie ma na zdjęciach. Jeśli ceny nie widać, ustaw null.",
].join(" ");

// Wspólny blok instrukcji kontekstowej (ten sam dla Claude i OpenAI).
export function contextText(opts: ExtractOptions, n: number): string {
  return (
    `Język docelowy: ${opts.targetLang}.\n` +
    `Lokal (podpowiedź): ${opts.restaurantHint ?? "nieznany"}.\n` +
    (opts.locationHint ? `Lokalizacja lokalu (GPS): ${opts.locationHint}.\n` : "") +
    (opts.cuisineHint
      ? `Wstępnie rozpoznana kuchnia (z szybkiego podglądu): ${opts.cuisineHint}. ` +
        `Potraktuj to jako MOCNĄ wskazówkę kontekstu (zweryfikuj z treścią menu) — pomaga w interpretacji lokalnych/regionalnych nazw dań.\n`
      : "") +
    `Połącz powyższe ${n} zdjęć w jedno menu.`
  );
}

/** Ścieżka OpenAI-compatible (OpenAI / Gemini): vision + structured outputs — ta sama schema co Claude. */
async function extractMenuOpenAI(
  images: InputImage[],
  opts: ExtractOptions,
  model: ModelId,
): Promise<{ menu: Menu; usage: Usage }> {
  const openai = getClientForModel(model);
  const tag = apiTag(model); // "openai" albo "google" — do diagnostyki

  const parts: import("openai").OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  images.forEach((img, i) => {
    parts.push({ type: "text", text: `— Zdjęcie ${i + 1} z ${images.length} —` });
    parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
  });
  parts.push({ type: "text", text: contextText(opts, images.length) });

  // STREAMING — jak Claude: zbieramy tekst na bieżąco i liczymy pozycje (marker "original"),
  // żeby apka pokazała „Odczytano N pozycji…". Usage (OpenAI) przychodzi w ostatnim chunku.
  const { text, finishReason, usageRaw } = await track(tag, "scan-menu", async () => {
    const stream = await openai.chat.completions.create({
      model,
      max_completion_tokens: MODELS[model].maxOutput,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: parts },
      ],
      response_format: {
        // strict tylko dla OpenAI (gpt-5*); Gemini compat bez strict (bywa restrykcyjny).
        type: "json_schema",
        json_schema: { name: "menu", strict: tag === "openai", schema: MENU_SCHEMA as unknown as Record<string, unknown> },
      },
      stream: true,
      // usage w strumieniu (ostatni chunk). OpenAI i Gemini-compat to wspierają.
      stream_options: { include_usage: true },
    });
    let acc = "";
    let finish: string | null = null;
    let uRaw: import("openai").OpenAI.Completions.CompletionUsage | undefined;
    let lastItems = -1;
    const itemState = { emitted: 0 };
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        acc += delta;
        if (opts.onProgress) {
          const items = (acc.match(/"original"\s*:/g) || []).length;
          if (items !== lastItems) {
            lastItems = items;
            opts.onProgress({ chars: acc.length, items });
          }
        }
        if (opts.onItem) emitNewItems(acc, itemState, opts.onItem);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) uRaw = chunk.usage;
    }
    return { text: acc, finishReason: finish, usageRaw: uRaw };
  });

  const usage = usageFromOpenAI(model, usageRaw);
  recordUsage(tag, usage.inputTokens, usage.outputTokens, usage.costUsd);
  // Relay do API: wysłane ≈ base64 obrazów (dominują), odebrane ≈ długość odpowiedzi.
  recordBytes(tag, images.reduce((n, i) => n + i.base64.length, 0), text.length);
  logUsage(`menu obrazów=${images.length} (${tag})`, model, usage);

  if (finishReason === "length") {
    throw new Error(
      "Menu jest bardzo duże i przekroczyło limit jednego skanu. Spróbuj zeskanować mniej stron naraz (np. po 3–4).",
    );
  }
  if (!text) throw new Error(`Brak odpowiedzi modelu OpenAI (finish=${finishReason ?? "?"}).`);
  try {
    return { menu: JSON.parse(text) as Menu, usage };
  } catch {
    throw new Error("Nie udało się odczytać menu (odpowiedź OpenAI niepełna).");
  }
}

/** Główna funkcja: wyciąga jedno menu z dowolnej liczby obrazów (+ zużycie tokenów). */
export async function extractMenu(
  images: InputImage[],
  opts: ExtractOptions,
): Promise<{ menu: Menu; usage: Usage }> {
  if (images.length === 0) throw new Error("Brak zdjęć do przetworzenia.");

  const model: ModelId = opts.model && isModelId(opts.model) ? opts.model : DEFAULT_MODEL;
  if (usesOpenAiApi(model)) return extractMenuOpenAI(images, opts, model);
  // max_tokens = maksimum modelu (to tylko sufit; nie kosztuje, gdy model skończy wcześniej).
  const maxTokens = MODELS[model].maxOutput;

  // Treść: dla każdego zdjęcia etykieta + obraz, na końcu instrukcja kontekstowa.
  const content: Anthropic.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: "text", text: `— Zdjęcie ${i + 1} z ${images.length} —` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    });
  });
  content.push({ type: "text", text: contextText(opts, images.length) });

  // Streaming — duże wyjście nie wpada w timeout, a max_tokens = maksimum modelu zapobiega ucięciu.
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: MENU_SCHEMA } },
  });
  // Postęp na żywo: licznik pozycji (po markerze "original") + emisja KOMPLETNYCH pozycji (onItem).
  if (opts.onProgress || opts.onItem) {
    let lastItems = -1;
    const itemState = { emitted: 0 };
    stream.on("text", (_delta, snapshot) => {
      if (opts.onProgress) {
        const items = (snapshot.match(/"original"\s*:/g) || []).length;
        if (items !== lastItems) {
          lastItems = items;
          opts.onProgress({ chars: snapshot.length, items });
        }
      }
      if (opts.onItem) emitNewItems(snapshot, itemState, opts.onItem);
    });
  }
  const response = await track("claude", "scan-menu", () => stream.finalMessage());

  // Zużycie tokenów + koszt (do licznika w apce + diagnostyki).
  const usage = usageFrom(model, response.usage);
  recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd);
  const claudeText = response.content.find((b) => b.type === "text");
  recordBytes("claude", images.reduce((n, i) => n + i.base64.length, 0), claudeText?.type === "text" ? claudeText.text.length : 0);
  logUsage(`menu obrazów=${images.length} stop=${response.stop_reason}`, model, usage);

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Menu jest bardzo duże i przekroczyło limit jednego skanu. " +
        "Spróbuj zeskanować mniej stron naraz (np. po 3–4).",
    );
  }

  // Przy output_config.format pierwszy blok tekstowy zawiera poprawny JSON.
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error(`Brak tekstowej odpowiedzi (stop_reason=${response.stop_reason}).`);
  }
  try {
    return { menu: JSON.parse(text.text) as Menu, usage };
  } catch {
    throw new Error(`Nie udało się odczytać menu (odpowiedź niepełna, stop=${response.stop_reason}).`);
  }
}

/** Wygoda dla CLI: jeden plik ze ścieżki. */
export async function extractMenuFromFile(
  imagePath: string,
  opts: ExtractOptions,
): Promise<{ menu: Menu; usage: Usage }> {
  const base64 = (await readFile(imagePath)).toString("base64");
  return extractMenu([{ base64, mediaType: mediaTypeFor(imagePath) }], opts);
}
