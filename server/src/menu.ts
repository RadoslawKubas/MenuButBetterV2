// Rdzeń: jedno lub WIELE zdjęć menu → vision (Claude lub OpenAI) → jedno spójne menu.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { MENU_SCHEMA, STRUCTURE_SCHEMA, ENRICH_SCHEMA, DISH_CATEGORIES, type Menu, type MenuItem, type MenuStructure, type StructItem, type DishCategory } from "./schema.ts";
import { usageFrom, usageFromOpenAI, logUsage, ZERO_USAGE, addUsage, type Usage } from "./usage.ts";
import { track, recordUsage, recordBytes } from "./apiLog.ts";
import { MODELS, DEFAULT_MODEL, isModelId, usesOpenAiApi, isOpenAiReasoning, apiTag, type ModelId } from "./models.ts";
import { getClientForModel } from "./openaiClient.ts";
import { cacheGet, cacheSet, cacheKey } from "./cache.ts";

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
  /** Model przebiegu STRUKTURY (vision). Domyślnie Sonnet 4.6. */
  model?: ModelId;
  /** Model przebiegu WZBOGACANIA (tekst). Domyślnie = model struktury. */
  enrichModel?: ModelId;
  /** Postęp odczytu na żywo (Claude, streaming): ile pozycji już wypisał model i ile znaków.
   *  Pozwala apce pokazać „Odczytano N pozycji…" zamiast samego licznika czasu. */
  onProgress?: (p: { chars: number; items: number }) => void;
  /** Każda sparsowana pozycja (nazwa + photo_query) NA ŻYWO ze strumienia — apka pokazuje nazwy
   *  i od razu dociąga dla nich tanie zdjęcia poglądowe (gotowe, zanim skan się skończy). */
  onItem?: (item: ScanItemStub) => void;
  /** Wzbogacona pozycja NA ŻYWO z przebiegu enrich (tłumaczenie + photo_query + opis) — apka
   *  sukcesywnie uzupełnia mini-karty (opis) i dociąga zdjęcie po photo_query. */
  onEnrichItem?: (item: ScanItemStub) => void;
  /** Nazwa lokalu + KUCHNIA NA ŻYWO — gdy tylko model je ustali (kuchnia jest w JSON przed daniami),
   *  nie czekając na koniec. Apka używa kuchni do wczesnego, spójnego enrichu (klucz cache). */
  onMeta?: (m: {
    restaurantName?: string;
    cuisine?: string;
    /** Który lokal z `nearbyVenues` model wskazał jako pasujący do tego menu (lub null). Emitowane
     *  po sparsowaniu struktury (na końcu, bo to obiekt — nie da się go wyłuskać ze strumienia). */
    venueMatch?: { index: number; by: "name" | "cuisine" } | null;
  }) => void;
  /** Pomiń cache skanu (LAB / porównania modeli — by liczyć realny koszt). */
  noCache?: boolean;
  /** Tylko STRUKTURA (vision) — bez enrichu. Zwraca Menu z oryginalnymi nazwami; enrich robi /enrich. */
  structureOnly?: boolean;
  /** Nazwy sekcji/grup ze WCZEŚNIEJSZYCH stron (gdy menu dzielone na partie) — ciągłość grup między
   *  kartkami: strona bez nagłówka kontynuuje znaną sekcję zamiast tworzyć „(bez tytułu)". */
  knownSections?: string[];
  /** Lokale „w pobliżu" (Nearby Search z apki, mały promień) — nazwa + kuchnia. Doklejane do promptu
   *  struktury, by vision wskazało venue_match (do którego z nich pasuje to menu). Pusto = brak listy. */
  nearbyVenues?: { name: string; cuisine?: string | null }[];
}

/** Pozycja wyłuskana ze strumienia — do podglądu (mini-karty) i wczesnego dociągania zdjęć. */
export interface ScanItemStub {
  original: string;
  translated: string;
  photoQuery: string;
  photoQueryLocal: string;
  branded: boolean;
  description: string;
  price: string | null;
  currency: string | null;
}

// Wyłuskuje KOMPLETNE pozycje z (jeszcze niepełnego) strumienia JSON: znajduje obiekty `{…}`
// zawierające "original" i parsuje je gdy domknięte (świadome stringów/escape/zagnieżdżeń).
// Daje pełne pola (nazwa, cena…). Emituje tylko NOWE (po liczniku).
function emitNewItems(text: string, state: { emitted: number }, onItem: (i: ScanItemStub) => void): void {
  let found = 0;
  let i = 0;
  while (true) {
    const k = text.indexOf('"original"', i);
    if (k < 0) break;
    const start = text.lastIndexOf("{", k); // obiekt pozycji otwiera się tuż przed "original" (1. pole)
    if (start < 0) {
      i = k + 10;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let p = start; p < text.length; p++) {
      const ch = text[p]!;
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = p; break; } }
    }
    if (end < 0) break; // obiekt jeszcze niedomknięty — doczyta się później
    found++;
    if (found > state.emitted) {
      try {
        const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        if (typeof o.original === "string") {
          onItem({
            original: o.original,
            translated: typeof o.translated === "string" ? o.translated : o.original,
            photoQuery: typeof o.photo_query === "string" ? o.photo_query : "",
            photoQueryLocal: typeof o.photo_query_local === "string" ? o.photo_query_local : "",
            branded: o.branded === true,
            // Strumień STRUKTURY niesie menu_description (opis z karty) — potrzebny do spójnego klucza
            // cache enrichu (rolling per ~8 dań w apce musi mieć ten sam md co finał). Enrich-stream ma description.
            description: typeof o.menu_description === "string" ? o.menu_description : typeof o.description === "string" ? o.description : "",
            price: typeof o.price === "string" ? o.price : null,
            currency: typeof o.currency === "string" ? o.currency : null,
          });
          state.emitted = found;
        }
      } catch {
        /* niepoprawny fragment — pomiń */
      }
    }
    i = end + 1;
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

// PRZEBIEG 1 — VISION, TYLKO STRUKTURA (transkrypcja tego, co widać; bez tłumaczeń i bez
// generowania opisów — to robi przebieg 2). Mały output = taniej/szybciej/mniej ucięć.
export const STRUCTURE_SYSTEM = [
  "Jesteś precyzyjnym transkryptorem menu restauracji.",
  "Otrzymasz jedno lub WIELE zdjęć — kolejne strony/fragmenty TEGO SAMEGO menu (czasem okładkę",
  "albo zdjęcie lokalu). Odczytaj TYLKO to, co realnie widać.",
  "Wyodrębnij WSZYSTKIE pozycje z podziałem na sekcje, w kolejności jak na stronach; nie duplikuj",
  "powtórzonych nagłówków ani pozycji. Dla każdej pozycji podaj `original` (nazwa DOKŁADNIE jak na",
  "menu), cenę i walutę (gdy widać; inaczej null) oraz `menu_description` = opis NADRUKOWANY na menu",
  "pod/obok pozycji (transkrypcja słowo w słowo). Gdy danie nie ma opisu na menu — pusty string.",
  "Podaj też `source_text` = przepisany FRAGMENT karty dla tej pozycji (pełna linijka/blok jak na",
  "menu: nazwa + ewentualny opis + cena), słowo w słowo — żeby pokazać użytkownikowi skąd pochodzi.",
  "NIE tłumacz, NIE generuj opisów, NIE zgaduj składników — to zrobi osobny krok.",
  "Ustal `cuisine` (rodzaj kuchni), `restaurant_language` (ISO 639-1) oraz `restaurant_name`/`restaurant_address`.",
  "Wśród zdjęć MOŻE być fasada/szyld/witryna lokalu, wizytówka, pieczątka, paragon, okładka, nagłówek lub",
  "stopka — KONIECZNIE odczytaj z nich NAZWĘ lokalu (i adres), nawet gdy dane zdjęcie nie zawiera dań.",
  "Nazwa lokalu to cenna informacja — szukaj jej wszędzie. Ze zdjęcia z zewnątrz NIE twórz pozycji menu",
  "(zostaw `sections` puste dla niego), ale ZWRÓĆ z niego `restaurant_name`/`restaurant_address` i `readable=true`",
  "(to przydatne zdjęcie). `readable=false` ustaw TYLKO gdy zdjęcie jest zbyt słabej jakości, by odczytać",
  "COKOLWIEK (mocno rozmazane/ciemne/ucięte) albo zupełnie przypadkowe (bez menu, bez nazwy, bez treści).",
  "WAŻNE: teksty, które NIE są daniami (czas oczekiwania, dopłaty: taras/serwis/cover, VAT/podatek,",
  "napiwek, godziny otwarcia, minimalne zamówienie, 'ceny zawierają/nie zawierają', ogólne uwagi o",
  "alergenach) NIE mogą trafić jako pozycje (dania). Wydziel je do tablicy `notes`: `text` (oryginał),",
  "`scope` ('menu' = całe menu, 'section' = konkretna sekcja), `section_index` (indeks sekcji od 0 gdy",
  "scope='section', inaczej null) i `kind` (set/included/wait/fee/tax/tip/hours/info). Gdy brak adnotacji — `notes` puste.",
  "ZESTAWY / MENU DNIA (np. 'Menú del día', lunch set, zestaw obiadowy — różnie w różnych krajach):",
  "wykryj jako adnotację `kind='set'` przy właściwej sekcji — w `text` zachowaj CENĘ zestawu, co jest",
  "WLICZONE i co DO WYBORU (np. 'do wyboru: 1. danie X/Y/Z, 2. danie A/B/C, deser lub kawa, napój w cenie').",
  "INFO DOTYCZĄCE CAŁEJ GRUPY dań (np. 'do każdego dania dodajemy sałatkę', 'w cenie pieczywo', 'ryż min.",
  "dla 2 osób') — adnotacja przy TEJ sekcji (scope='section' + section_index), `kind='included'` gdy coś",
  "dochodzi/jest wliczone, inaczej 'info'; dzięki temu pokażemy to pod nazwą grupy (tyczy wszystkich jej dań).",
  "(Przypomnienie) `readable=false` ZAR0WNO dla zbyt słabej jakości (rozmazane/ciemne/ucięte), JAK i zupełnie",
  "przypadkowych zdjęć bez menu I bez nazwy lokalu — wtedy `sections` puste. Samo 'to nie menu' to ZA MAŁO,",
  "by dać readable=false: jeśli widać nazwę/szyld/wizytówkę → readable=true i zwróć `restaurant_name`.",
  "Ustaw `low_quality=true`, gdy jakość jest SŁABA, ale częściowo dało się odczytać (np. widać nazwy działów,",
  "lecz pozycje są za małe/rozmyte/ucięte i odczyt może być NIEPEŁNY lub niepewny) — mimo to wypisz wszystko,",
  "co dało się odczytać. Przy wyraźnym, pełnym odczycie `low_quality=false`.",
  "Nie wymyślaj pozycji, których nie ma na zdjęciach.",
].join(" ");

// PRZEBIEG 2 — TEKST, WSADOWO PO NAZWACH: tłumaczenie + photo_query/_local + branded + opis +
// składniki/alergeny/kategoria/dieta/ostrość. Bez obrazu — z nazwy i kontekstu (kuchnia/kraj).
export const ENRICH_SYSTEM = [
  "Jesteś ekspertem kulinarnym i tłumaczem. Dostajesz LISTĘ pozycji menu (sama nazwa + ewentualny",
  "opis z karty + numer `index`), kontekst kuchni i kraju/miasta lokalu oraz język docelowy.",
  "Dla KAŻDEJ pozycji zwróć wzbogacenie po jej `index` (i tłumaczenia nazw sekcji po `index`).",
  "Wszystko MUSI pasować do podanej kuchni i regionu.",
  "Tłumacz nazwy (pozycji i sekcji) na język docelowy.",
  "Gdy pozycja ma OPIS Z KARTY (część po '|' w wejściu): przetłumacz go WIERNIE do `menu_description_translated`",
  "(dokładnie, bez dodatków) i OPRZYJ na nim generowany `description`. Gdy opisu z karty nie ma — `menu_description_translated` to pusty string.",
  "OPIS (`description`) pisz ZWIĘŹLE i RZECZOWO, z tego, co wynika z nazwy/opisu z karty i typowego przyrządzania",
  "dania w TEJ kuchni/regionie. NIE upiększaj i NIE dodawaj nietypowych składników (np. NIE dodawaj awokado",
  "do zwykłej zielonej sałatki w kuchni indyjskiej). Lepiej ogólnie i PRAWDZIWIE niż barwnie i zmyślnie.",
  "W `ingredients` tylko składniki pewne/typowe; alergeny i flagi dietetyczne szacuj zachowawczo.",
  "`photo_query`: KANONICZNA nazwa potrawy do zdjęć (zromanizowana) + typ/kuchnia dla jednoznaczności",
  "(np. 'mango chicken curry indian', 'patatas bravas'). Opisz CZYM danie jest, nie markową nazwą z menu.",
  "`photo_query_local`: nazwa do zdjęć W JĘZYKU KRAJU lokalu (z kontekstu). Gdy język menu = język kraju,",
  "zwykle = original; gdy się nie da — powtórz photo_query.",
  "`branded`: true dla markowych/paczkowanych produktów o stałym wyglądzie (Coca-Cola, butelkowana woda),",
  "false dla potraw z kuchni.",
  "Gdy dostaniesz ADNOTACJE menu (sekcja 'ADNOTACJE'), przetłumacz każdą na język docelowy i zwróć w",
  "`notes` po jej `index` (zachowaj sens; krótko).",
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

/** Przebieg 1 (OpenAI/Gemini): vision → STRUKTURA menu (bez tłumaczeń/opisów). */
async function structureOpenAI(
  images: InputImage[],
  opts: ExtractOptions,
  model: ModelId,
): Promise<{ structure: MenuStructure; usage: Usage }> {
  const openai = getClientForModel(model);
  const tag = apiTag(model); // "openai" albo "google" — do diagnostyki

  const parts: import("openai").OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  images.forEach((img, i) => {
    parts.push({ type: "text", text: `— Zdjęcie ${i + 1} z ${images.length} —` });
    parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
  });
  parts.push({ type: "text", text: contextTextStructure(opts, images.length) });

  // STREAMING — zbieramy tekst na bieżąco i liczymy/emitujemy pozycje (marker "original"),
  // żeby apka pokazała „Odczytano N pozycji…" i nazwy na żywo. Usage w ostatnim chunku.
  const { text, finishReason, usageRaw } = await track(tag, "scan-structure", async () => {
    const stream = await openai.chat.completions.create({
      model,
      max_completion_tokens: MODELS[model].maxOutput,
      messages: [
        { role: "system", content: STRUCTURE_SYSTEM },
        { role: "user", content: parts },
      ],
      response_format: {
        // strict tylko dla OpenAI (gpt-5*); Gemini compat bez strict (bywa restrykcyjny).
        type: "json_schema",
        json_schema: { name: "structure", strict: tag === "openai", schema: STRUCTURE_SCHEMA as unknown as Record<string, unknown> },
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
  recordUsage(tag, usage.inputTokens, usage.outputTokens, usage.costUsd, model);
  // Relay do API: wysłane ≈ base64 obrazów (dominują), odebrane ≈ długość odpowiedzi.
  recordBytes(tag, images.reduce((n, i) => n + i.base64.length, 0), text.length);
  logUsage(`struktura obrazów=${images.length} (${tag})`, model, usage);

  if (finishReason === "length") {
    throw new Error(
      "Menu jest bardzo duże i przekroczyło limit jednego skanu. Spróbuj zeskanować mniej stron naraz (np. po 3–4).",
    );
  }
  if (!text) throw new Error(`Brak odpowiedzi modelu OpenAI (finish=${finishReason ?? "?"}).`);
  try {
    return { structure: JSON.parse(text) as MenuStructure, usage };
  } catch {
    throw new Error("Nie udało się odczytać struktury menu (odpowiedź OpenAI niepełna).");
  }
}

/** Główna funkcja: wyciąga jedno menu z dowolnej liczby obrazów (+ zużycie tokenów). */
/** Hash zestawu plików (kolejność ma znaczenie) — stabilny klucz „ten sam plik/zestaw przyszedł". */
function imagesHash(images: InputImage[]): string {
  const h = createHash("sha256");
  for (const img of images) { h.update(img.mediaType); h.update("|"); h.update(img.base64); h.update("\n"); }
  return h.digest("hex").slice(0, 32);
}
/** Klucz cache skanu: hash zestawu + KONTEKST wpływający na wynik (język/lokalizacja/kuchnia/lokal/modele). */
function scanCacheKey(images: InputImage[], opts: ExtractOptions, model: ModelId, enrichModel: ModelId): string {
  return cacheKey("menu-scan", imagesHash(images), opts.targetLang, opts.locationHint, opts.restaurantHint, opts.cuisineHint, model, enrichModel);
}

// Kontekst dla PRZEBIEGU 1 (struktura) — bez instrukcji tłumaczenia; lokalizacja/kuchnia pomagają
// poprawnie odczytać lokalne nazwy dań.
function contextTextStructure(opts: ExtractOptions, n: number): string {
  return (
    `Lokal (podpowiedź): ${opts.restaurantHint ?? "nieznany"}.\n` +
    (opts.locationHint ? `Lokalizacja lokalu (GPS): ${opts.locationHint}.\n` : "") +
    (opts.cuisineHint ? `Wstępnie rozpoznana kuchnia: ${opts.cuisineHint} (wskazówka — zweryfikuj z treścią).\n` : "") +
    (opts.nearbyVenues?.length
      ? `W POBLIŻU (z GPS) są te lokale:\n` +
        opts.nearbyVenues.map((v, i) => `  ${i}) ${v.name}${v.cuisine ? ` — ${v.cuisine}` : ""}`).join("\n") +
        `\nJeśli to menu należy do JEDNEGO z nich — wskaż go w polu venue_match. NAJPIERW po nazwie widocznej na karcie/szyldzie (by='name'); jeśli nazwy nie widać, a po KUCHNI pasuje JEDNOZNACZNIE jeden (jeden taki w okolicy) — wskaż go (by='cuisine'). Brak pewnego dopasowania → venue_match=null.\n`
      : "") +
    (opts.knownSections?.length
      ? `UWAGA — to KOLEJNE strony tego samego menu. Sekcje/grupy z wcześniejszych stron: ${opts.knownSections.join(", ")}. ` +
        `Jeśli strona ZACZYNA się od pozycji BEZ widocznego nagłówka grupy, prawdopodobnie KONTYNUUJĄ one ostatnią grupę z poprzedniej strony — przypisz je do PASUJĄCEJ znanej sekcji (DOKŁADNIE ta sama nazwa), NIE twórz „(bez tytułu)".\n`
      : "") +
    `Połącz powyższe ${n} zdjęć w JEDNĄ strukturę menu (transkrypcja).`
  );
}

/**
 * Dyspozytor: CACHE skanu (dokładnie ten sam zestaw plików + ten sam kontekst i model → zwróć
 * zapamiętane menu, bez płatnego odczytu vision), a przy pudle — odczyt Claude/OpenAI i zapis.
 */
export async function extractMenu(
  images: InputImage[],
  opts: ExtractOptions,
): Promise<{ menu: Menu; usage: Usage; cached?: boolean; readable?: boolean; poorQuality?: boolean; enriched?: boolean }> {
  if (images.length === 0) throw new Error("Brak zdjęć do przetworzenia.");
  const model: ModelId = opts.model && isModelId(opts.model) ? opts.model : DEFAULT_MODEL;
  const enrichModel: ModelId = opts.enrichModel && isModelId(opts.enrichModel) ? opts.enrichModel : model;

  // FAST PATH — ten sam zestaw plików + ten sam kontekst i modele → gotowe menu (zero płatnych wywołań).
  const ck = scanCacheKey(images, opts, model, enrichModel);
  if (!opts.noCache) {
    const hit = await cacheGet<Menu>("menu-scan", ck, { op: "scan" });
    if (hit) return { menu: hit, usage: ZERO_USAGE, cached: true, readable: true, enriched: true };
  }

  let total: Usage = ZERO_USAGE;
  // PRZEBIEG 1 — STRUKTURA (vision). Cache struktury per zestaw plików + model (BEZ języka/lokalizacji —
  // transkrypcja jest od nich niezależna → reuse między językami). Streaming nazw przez onItem/onProgress.
  // Klucz cache STRUKTURY: cała partia zdjęć (imagesHash) + model. Gdy są knownSections (kolejne partie
  // z kontekstem ciągłości grup) — dołącz je do klucza (inny kontekst → inna struktura). Pusty → klucz
  // jak dotąd (wsteczna zgodność z istniejącym cache pierwszej partii).
  const sectCtx = opts.knownSections?.length ? opts.knownSections.join("|") : "";
  const sck = sectCtx
    ? cacheKey("menu-structure", imagesHash(images), model, sectCtx)
    : cacheKey("menu-structure", imagesHash(images), model);
  let structure = !opts.noCache ? await cacheGet<MenuStructure>("menu-structure", sck, { op: "scan" }) : null;
  const structureFromCache = structure !== null; // hit ze structure cache → skan bez kosztu modelu
  if (structure) {
    replayStructureItems(structure, opts); // odtwórz licznik/nazwy z cache (apka pokaże pozycje)
  } else {
    const s = usesOpenAiApi(model) ? await structureOpenAI(images, opts, model) : await structureClaude(images, opts, model);
    structure = s.structure;
    total = addUsage(total, s.usage);
    if (!opts.noCache) void cacheSet("menu-structure", sck, structure);
  }

  // venue_match: który z „W POBLIŻU" wskazał model. Emituj RAZ po sparsowaniu (to obiekt — nie da się
  // go wyłuskać ze strumienia jak restaurant_name). Tylko gdy lista była podana (inaczej nie ma sensu).
  if (opts.onMeta && opts.nearbyVenues?.length) {
    const vm = structure.venue_match;
    const ok = vm && typeof vm.index === "number" && vm.index >= 0 && vm.index < opts.nearbyVenues.length;
    opts.onMeta({ venueMatch: ok ? { index: vm!.index, by: vm!.by === "cuisine" ? "cuisine" : "name" } : null });
  }

  const readable = structure.readable !== false; // brak pola → traktuj jako czytelne
  const poorQuality = structure.low_quality === true; // czytelne, ale słaba jakość → wynik może być niepełny

  // TYLKO STRUKTURA (Faza A apki): zwróć Menu z oryginalnymi nazwami, bez enrichu. Pozycje już
  // wyemitowane przez onItem podczas struktury. Enrich (tłumaczenia/opisy) zrobi osobno /enrich.
  if (opts.structureOnly) {
    return { menu: buildStructureMenu(structure), usage: total, readable, poorQuality, enriched: false, cached: structureFromCache };
  }

  // PRZEBIEG 2 — WZBOGACANIE (tekst, z cache per pozycja) → pełne Menu.
  const enriched = await enrichMenu(structure, opts, enrichModel);
  total = addUsage(total, enriched.usage);
  if (!opts.noCache) void cacheSet("menu-scan", ck, enriched.menu, { lang: opts.targetLang });
  return { menu: enriched.menu, usage: total, readable, poorQuality, enriched: true };
}

/** Przebieg 1 (Claude): vision → STRUKTURA menu (streaming nazw). */
async function structureClaude(
  images: InputImage[],
  opts: ExtractOptions,
  model: ModelId,
): Promise<{ structure: MenuStructure; usage: Usage }> {
  const maxTokens = MODELS[model].maxOutput;
  const content: Anthropic.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: "text", text: `— Zdjęcie ${i + 1} z ${images.length} —` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
  });
  content.push({ type: "text", text: contextTextStructure(opts, images.length) });

  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system: STRUCTURE_SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: STRUCTURE_SCHEMA } },
  });
  if (opts.onProgress || opts.onItem || opts.onMeta) {
    let lastItems = -1;
    const itemState = { emitted: 0 };
    let nameSent = false;
    let cuisineSent = false;
    stream.on("text", (_delta, snapshot) => {
      if (opts.onProgress) {
        const items = (snapshot.match(/"original"\s*:/g) || []).length;
        if (items !== lastItems) { lastItems = items; opts.onProgress({ chars: snapshot.length, items }); }
      }
      if (opts.onMeta && !nameSent) {
        const m = snapshot.match(/"restaurant_name"\s*:\s*"([^"]+)"/); // nazwa pojawia się wcześnie w JSON
        if (m && m[1]!.trim()) { nameSent = true; opts.onMeta({ restaurantName: m[1] }); }
      }
      if (opts.onMeta && !cuisineSent) {
        const cm = snapshot.match(/"cuisine"\s*:\s*"([^"]+)"/); // kuchnia jest w JSON przed sekcjami/daniami
        if (cm && cm[1]!.trim()) { cuisineSent = true; opts.onMeta({ cuisine: cm[1] }); }
      }
      if (opts.onItem) emitNewItems(snapshot, itemState, opts.onItem);
    });
  }
  const response = await track("claude", "scan-structure", () => stream.finalMessage());
  const usage = usageFrom(model, response.usage);
  recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd, model);
  const claudeText = response.content.find((b) => b.type === "text");
  recordBytes("claude", images.reduce((n, i) => n + i.base64.length, 0), claudeText?.type === "text" ? claudeText.text.length : 0);
  logUsage(`struktura obrazów=${images.length} stop=${response.stop_reason}`, model, usage);

  if (response.stop_reason === "max_tokens") {
    throw new Error("Menu jest bardzo duże i przekroczyło limit jednego skanu. Spróbuj zeskanować mniej stron naraz (np. po 3–4).");
  }
  if (!claudeText || claudeText.type !== "text") throw new Error(`Brak tekstowej odpowiedzi (stop_reason=${response.stop_reason}).`);
  try {
    return { structure: JSON.parse(claudeText.text) as MenuStructure, usage };
  } catch {
    throw new Error(`Nie udało się odczytać struktury menu (odpowiedź niepełna, stop=${response.stop_reason}).`);
  }
}

// Odtwarza licznik pozycji i nazwy z gotowej struktury (cache) — apka pokazuje to samo, co przy
// realnym odczycie. photoQuery puste → apka NIE prefetchuje (zrobi to po enrich z dobrym hasłem).
function replayStructureItems(structure: MenuStructure, opts: ExtractOptions): void {
  if (!opts.onProgress && !opts.onItem) return;
  let n = 0;
  for (const s of structure.sections) for (const it of s.items) {
    n++;
    opts.onItem?.({ original: it.original, translated: it.original, photoQuery: "", photoQueryLocal: "", branded: false, description: it.menu_description || "", price: it.price, currency: it.currency });
  }
  opts.onProgress?.({ chars: 0, items: n });
}

// Wzbogacenie pojedynczej pozycji (wynik przebiegu 2) — cache'owane per pozycja.
interface ItemEnrich {
  index: number;
  translated: string;
  photo_query: string;
  photo_query_local: string;
  branded: boolean;
  /** Wierne tłumaczenie opisu NADRUKOWANEGO na karcie (gdy był), inaczej "". */
  menu_description_translated?: string;
  description: string;
  ingredients: string[];
  allergens: string[];
  category: string;
  dietary: { vegetarian: boolean; vegan: boolean; gluten_free: boolean };
  spice_level: number;
}

/** Kraj/region z „Miasto, Kraj" (ostatni człon) — do klucza cache enrich (szerszy reuse niż miasto). */
function countryOf(loc?: string): string | undefined {
  if (!loc) return undefined;
  return loc.split(",").pop()?.trim() || loc;
}

/** Składa pozycję pełnego menu ze struktury (vision) + wzbogacenia (tekst), z bezpiecznymi fallbackami. */
function assembleItem(it: StructItem, e: ItemEnrich | null): MenuItem {
  const category: DishCategory = e && (DISH_CATEGORIES as readonly string[]).includes(e.category) ? (e.category as DishCategory) : "other";
  const spice = (e && [0, 1, 2, 3].includes(e.spice_level) ? e.spice_level : 0) as 0 | 1 | 2 | 3;
  return {
    original: it.original,
    translated: e?.translated || it.original,
    source_text: it.source_text || it.original,
    photo_query: e?.photo_query || it.original,
    photo_query_local: e?.photo_query_local || e?.photo_query || it.original,
    branded: e?.branded ?? false,
    menu_description: it.menu_description || "",
    menu_description_translated: e?.menu_description_translated || (it.menu_description && !e ? it.menu_description : ""),
    description: e?.description || it.menu_description || "",
    ingredients: e?.ingredients ?? [],
    allergens: e?.allergens ?? [],
    category,
    dietary: e?.dietary ?? { vegetarian: false, vegan: false, gluten_free: false },
    spice_level: spice,
    price: it.price,
    currency: it.currency,
  };
}

/** Buduje Menu wprost ze STRUKTURY (bez enrichu): oryginalne nazwy, brak tłumaczeń/opisów.
 *  Używane w trybie structureOnly (Faza A apki — szybkie, kompletna struktura do przeglądania). */
export function buildStructureMenu(structure: MenuStructure): Menu {
  return {
    restaurant_name: structure.restaurant_name,
    restaurant_address: structure.restaurant_address,
    restaurant_language: structure.restaurant_language,
    cuisine: structure.cuisine,
    sections: structure.sections.map((s) => ({
      name: s.name,
      name_translated: s.name,
      items: s.items.map((it) => assembleItem(it, null)),
    })),
    notes: (structure.notes ?? []).map((n) => ({ text: n.text, text_translated: n.text, scope: n.scope, section_index: n.section_index, kind: n.kind })),
  };
}

/** Odwrotność: z (kompletnego) Menu struktury robi MenuStructure do enrichu (Faza B — bez zdjęć). */
export function menuToStructure(menu: Menu): MenuStructure {
  return {
    restaurant_name: menu.restaurant_name,
    restaurant_address: menu.restaurant_address,
    restaurant_language: menu.restaurant_language,
    cuisine: menu.cuisine,
    sections: menu.sections.map((s) => ({
      name: s.name,
      items: s.items.map((it) => ({ original: it.original, menu_description: it.menu_description ?? "", source_text: it.source_text ?? "", price: it.price, currency: it.currency })),
    })),
    notes: (menu.notes ?? []).map((n) => ({ text: n.text, scope: n.scope, section_index: n.section_index, kind: n.kind })),
    readable: true,
    low_quality: false,
  };
}

// Wyłuskuje KOMPLETNE obiekty wzbogacenia ze strumienia enrich (marker "photo_query") i emituje je
// jako pozycje (mapując index→original) — apka uzupełnia mini-karty opisem i dociąga zdjęcie na żywo.
function emitEnrichItems(text: string, state: { emitted: number }, items: { gi: number; original: string }[], onItem: (i: ScanItemStub) => void): void {
  let found = 0;
  let i = 0;
  while (true) {
    const k = text.indexOf('"photo_query"', i);
    if (k < 0) break;
    const start = text.lastIndexOf("{", k);
    if (start < 0) { i = k + 13; continue; }
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let p = start; p < text.length; p++) {
      const ch = text[p]!;
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = p; break; } }
    }
    if (end < 0) break;
    found++;
    if (found > state.emitted) {
      try {
        const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        if (typeof o.index === "number" && typeof o.photo_query === "string") {
          // index = pozycja na liście wysłanej do modelu (gęsta), więc bierzemy wprost items[index].
          const orig = items[o.index]?.original;
          if (orig) {
            onItem({
              original: orig,
              translated: typeof o.translated === "string" ? o.translated : orig,
              photoQuery: o.photo_query,
              photoQueryLocal: typeof o.photo_query_local === "string" ? o.photo_query_local : "",
              branded: o.branded === true,
              description: typeof o.description === "string" ? o.description : "",
              price: null,
              currency: null,
            });
            state.emitted = found;
          }
        }
      } catch { /* niepełny fragment — doczyta się później */ }
    }
    i = end + 1;
  }
}

interface EnrichResult { sections: { index: number; name_translated: string }[]; items: ItemEnrich[]; notes: { index: number; text_translated: string }[]; usage: Usage }

/** Jedno tekstowe wywołanie wzbogacające (Claude/OpenAI) dla podanych sekcji, pozycji i adnotacji. */
async function enrichCall(
  model: ModelId,
  opts: ExtractOptions,
  cuisine: string,
  country: string | undefined,
  sects: { idx: number; name: string }[],
  items: { gi: number; original: string; menu_description: string }[],
  notes: { idx: number; text: string }[] = [],
): Promise<EnrichResult> {
  const ctx =
    `Kuchnia: ${cuisine}.\n` +
    (country ? `Kraj/region lokalu: ${country}.\n` : "") +
    (opts.locationHint ? `Lokalizacja: ${opts.locationHint}.\n` : "") +
    (opts.restaurantHint ? `Lokal: ${opts.restaurantHint}.\n` : "") +
    `Język docelowy: ${opts.targetLang}.\n\n`;
  // INDEKS = pozycja na PODANEJ niżej liście (GĘSTE 0..N-1), NIE numer globalny. Mapowanie z powrotem na
  // właściwe danie robi wywołujący przez needItems[index].gi — odporne, gdy model odda przesunięte indeksy
  // (rzadkie gi przy re-skanie z częściowym cache potrafiły wpisać treść pod złe danie i zatruć cache).
  const sectsTxt = sects.length ? "SEKCJE (index → nazwa) do przetłumaczenia:\n" + sects.map((s, i) => `[${i}] ${s.name}`).join("\n") + "\n\n" : "";
  const itemsTxt = items.length ? "POZYCJE (index → nazwa | opis z menu) do wzbogacenia:\n" + items.map((it, i) => `[${i}] ${it.original}${it.menu_description ? ` | ${it.menu_description}` : ""}`).join("\n") : "";
  const notesTxt = notes.length ? "\n\nADNOTACJE (index → tekst) do przetłumaczenia:\n" + notes.map((n, i) => `[${i}] ${n.text}`).join("\n") : "";
  const userText = ctx + sectsTxt + itemsTxt + notesTxt + "\n\nZwróć enrich dla KAŻDEGO podanego indeksu (sekcji, pozycji i adnotacji), używając DOKŁADNIE tych samych numerów index z list powyżej.";

  if (usesOpenAiApi(model)) {
    const openai = getClientForModel(model);
    const tag = apiTag(model);
    const params: import("openai").OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model,
      max_completion_tokens: MODELS[model].maxOutput,
      messages: [
        { role: "system", content: ENRICH_SYSTEM },
        { role: "user", content: userText },
      ],
      response_format: { type: "json_schema", json_schema: { name: "enrich", strict: tag === "openai", schema: ENRICH_SCHEMA as unknown as Record<string, unknown> } },
    };
    if (isOpenAiReasoning(model)) params.reasoning_effort = "minimal";
    else params.temperature = 0; // determinizm photo_query (modele reasoning nie przyjmują temperature)
    const resp = await track(tag, "enrich", () => openai.chat.completions.create(params));
    const usage = usageFromOpenAI(model, resp.usage);
    recordUsage(tag, usage.inputTokens, usage.outputTokens, usage.costUsd, model);
    logUsage(`enrich pozycji=${items.length} (${tag})`, model, usage);
    const txt = resp.choices[0]?.message?.content;
    const parsed = txt ? (JSON.parse(txt) as Partial<EnrichResult>) : {};
    return { sections: parsed.sections ?? [], items: parsed.items ?? [], notes: parsed.notes ?? [], usage };
  }

  // Streaming — duże menu daje duże wyjście; non-stream przy wysokim max_tokens odpala guard SDK
  // („Streaming is required…"). Strumień to omija (jak przebieg struktury).
  const stream = client.messages.stream({
    model,
    max_tokens: MODELS[model].maxOutput,
    temperature: 0, // determinizm: ten sam danie → ten sam photo_query → stabilny klucz cache
    system: [{ type: "text", text: ENRICH_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
    output_config: { format: { type: "json_schema", schema: ENRICH_SCHEMA } },
  });
  if (opts.onEnrichItem) {
    const est = { emitted: 0 };
    stream.on("text", (_d, snap) => emitEnrichItems(snap, est, items, opts.onEnrichItem!));
  }
  const resp = await track("claude", "enrich", () => stream.finalMessage());
  const usage = usageFrom(model, resp.usage);
  recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd, model);
  logUsage(`enrich pozycji=${items.length}`, model, usage);
  const t = resp.content.find((b) => b.type === "text");
  const parsed = t && t.type === "text" ? (JSON.parse(t.text) as Partial<EnrichResult>) : {};
  return { sections: parsed.sections ?? [], items: parsed.items ?? [], notes: parsed.notes ?? [], usage };
}

/**
 * PRZEBIEG 2 — wzbogacenie struktury w pełne Menu (tłumaczenia, photo_query, opisy itd.). Cache per
 * pozycja (`original+menu_desc + kuchnia + kraj + język + model`) i per nazwa sekcji — do modelu idą
 * TYLKO niezcache'owane pozycje. Składa wynik z bezpiecznymi fallbackami.
 */
export async function enrichMenu(structure: MenuStructure, opts: ExtractOptions, model: ModelId): Promise<{ menu: Menu; usage: Usage }> {
  const targetLang = opts.targetLang;
  const cuisine = structure.cuisine;
  const country = countryOf(opts.locationHint);
  // Klucz cache enrichu: lokalizacja na poziomie MIASTA/REGIONU (pełny locationHint), nie tylko kraju —
  // dokładniejsze regionalnie (np. inna paella), kosztem węższego reużycia. Fallback: kraj → "".
  const locKey = opts.locationHint?.trim() || country || "";

  const flat: { original: string; menu_description: string }[] = [];
  for (const s of structure.sections) for (const it of s.items) flat.push({ original: it.original, menu_description: it.menu_description });

  const notes = structure.notes ?? [];
  const itemKey = (original: string, md: string) => cacheKey("item-enrich", original, md, cuisine, locKey, targetLang, model);
  const sectKey = (name: string) => cacheKey("item-enrich", "§sect", name, targetLang, model);
  const noteKey = (text: string) => cacheKey("item-enrich", "§note", text, targetLang, model);

  const enrichByGi = new Array<ItemEnrich | null>(flat.length).fill(null);
  const sectTrans = new Array<string | null>(structure.sections.length).fill(null);
  const noteTrans = new Array<string | null>(notes.length).fill(null);
  const needItems: { gi: number; original: string; menu_description: string }[] = [];
  const needSects: { idx: number; name: string }[] = [];
  const needNotes: { idx: number; text: string }[] = [];

  if (!opts.noCache) {
    await Promise.all(flat.map(async (f, gi) => {
      const hit = await cacheGet<ItemEnrich>("item-enrich", itemKey(f.original, f.menu_description), { op: "enrich" });
      if (hit) enrichByGi[gi] = hit; else needItems.push({ gi, original: f.original, menu_description: f.menu_description });
    }));
    await Promise.all(structure.sections.map(async (s, idx) => {
      const hit = await cacheGet<string>("item-enrich", sectKey(s.name), { op: "enrich" });
      if (hit != null) sectTrans[idx] = hit; else needSects.push({ idx, name: s.name });
    }));
    await Promise.all(notes.map(async (n, idx) => {
      const hit = await cacheGet<string>("item-enrich", noteKey(n.text), { op: "enrich" });
      if (hit != null) noteTrans[idx] = hit; else needNotes.push({ idx, text: n.text });
    }));
  } else {
    flat.forEach((f, gi) => needItems.push({ gi, original: f.original, menu_description: f.menu_description }));
    structure.sections.forEach((s, idx) => needSects.push({ idx, name: s.name }));
    notes.forEach((n, idx) => needNotes.push({ idx, text: n.text }));
  }

  // Pozycje z CACHE → wyemituj od razu (apka wypełnia karty), reszta dojdzie ze strumienia enrich.
  if (opts.onEnrichItem) {
    flat.forEach((f, gi) => {
      const e = enrichByGi[gi];
      if (e) opts.onEnrichItem!({ original: f.original, translated: e.translated || f.original, photoQuery: e.photo_query || "", photoQueryLocal: e.photo_query_local || "", branded: e.branded === true, description: e.description || "", price: null, currency: null });
    });
  }

  let usage = ZERO_USAGE;
  if (needItems.length || needSects.length || needNotes.length) {
    const r = await enrichCall(model, opts, cuisine, country, needSects, needItems, needNotes);
    usage = r.usage;
    // it.index/s.index/n.index = pozycja na liście WYSŁANEJ do modelu (need*), NIE numer globalny. Mapuj
    // przez need*[index] na właściwe danie/sekcję/adnotację — niedopasowany indeks (poza zakresem) pomiń.
    for (const s of r.sections) {
      const tgt = needSects[s.index];
      if (tgt) {
        sectTrans[tgt.idx] = s.name_translated;
        if (!opts.noCache) void cacheSet("item-enrich", sectKey(structure.sections[tgt.idx]!.name), s.name_translated, { lang: targetLang });
      }
    }
    for (const it of r.items) {
      const tgt = needItems[it.index];
      if (tgt) {
        enrichByGi[tgt.gi] = it;
        if (!opts.noCache) void cacheSet("item-enrich", itemKey(flat[tgt.gi]!.original, flat[tgt.gi]!.menu_description), it, { lang: targetLang });
      }
    }
    for (const n of r.notes) {
      const tgt = needNotes[n.index];
      if (tgt) {
        noteTrans[tgt.idx] = n.text_translated;
        if (!opts.noCache) void cacheSet("item-enrich", noteKey(notes[tgt.idx]!.text), n.text_translated, { lang: targetLang });
      }
    }
  }

  let gi = 0;
  const menu: Menu = {
    restaurant_name: structure.restaurant_name,
    restaurant_address: structure.restaurant_address,
    restaurant_language: structure.restaurant_language,
    cuisine: structure.cuisine,
    sections: structure.sections.map((s, si) => ({
      name: s.name,
      name_translated: sectTrans[si] ?? s.name,
      items: s.items.map((it) => assembleItem(it, enrichByGi[gi++] ?? null)),
    })),
    notes: notes.map((n, i) => ({ text: n.text, text_translated: noteTrans[i] ?? n.text, scope: n.scope, section_index: n.section_index, kind: n.kind })),
  };
  return { menu, usage };
}

/** Wygoda dla CLI: jeden plik ze ścieżki. */
export async function extractMenuFromFile(
  imagePath: string,
  opts: ExtractOptions,
): Promise<{ menu: Menu; usage: Usage }> {
  const base64 = (await readFile(imagePath)).toString("base64");
  return extractMenu([{ base64, mediaType: mediaTypeFor(imagePath) }], opts);
}
