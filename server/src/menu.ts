// Rdzeń: jedno lub WIELE zdjęć menu → vision (Claude lub OpenAI) → jedno spójne menu.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { MENU_SCHEMA, STRUCTURE_SCHEMA, ENRICH_SCHEMA, ONEPASS_SCHEMA, DISH_CATEGORIES, NOTE_KINDS, type Menu, type MenuItem, type MenuNote, type MenuStructure, type StructItem, type DishCategory, type NoteKind } from "./schema.ts";
import { usageFrom, usageFromOpenAI, logUsage, ZERO_USAGE, addUsage, type Usage } from "./usage.ts";
import { track, recordUsage, recordBytes } from "./apiLog.ts";
import { MODELS, DEFAULT_MODEL, isModelId, usesOpenAiApi, isOpenAiReasoning, supportsTemperature, apiTag, type ModelId } from "./models.ts";
import { getClientForModel } from "./openaiClient.ts";
import { cacheGet, cacheSet, cacheKey, BatchInFlight } from "./cache.ts";
import { langCode } from "./lang.ts";

// Rejestr modeli + walidator współdzielone z resztą serwera (re-eksport z models.ts).
export { MODELS, DEFAULT_MODEL, isModelId, type ModelId };

const client = new Anthropic({ maxRetries: 4 }); // klucz z ANTHROPIC_API_KEY (env); retry na sieć/429/5xx

export type MediaType = "image/jpeg" | "image/png" | "image/webp";

export interface InputImage {
  base64: string;
  mediaType: MediaType;
  /** STABILNY hash ŹRÓDŁOWEGO (niezmodyfikowanego) zdjęcia — liczony na telefonie z oryginału, PRZED
   *  resize/JPEG do modelu. Klucz cache struktury: nie zmienia się przez modyfikację → ponowny skan tego
   *  samego zdjęcia trafia. Brak (stary klient) → struktury nie cache'ujemy dla tej partii. */
  srcHash?: string;
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
  /** NIEPEWNA nazwa odczytana z SZYLDU (triaż w apce) — sceptyczny kontekst: użyj TYLKO gdy karta potwierdza. */
  nameGuess?: string;
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
  /** Prefiks stabilnego `id` pozycji (np. „b0-") — nadawany NA ŻYWO w streamie (onItem) i w finalnym Menu po
   *  tym samym porządku dokumentu (rolling enrich może wzbogacać po `id` zanim struktura jest scalona). */
  idPrefix?: string;
  /** Nazwy sekcji/grup ze WCZEŚNIEJSZYCH stron (gdy menu dzielone na partie) — ciągłość grup między
   *  kartkami: strona bez nagłówka kontynuuje znaną sekcję zamiast tworzyć „(bez tytułu)". */
  knownSections?: string[];
  /** Lokale „w pobliżu" (Nearby Search z apki, mały promień) — nazwa + kuchnia. Doklejane do promptu
   *  struktury, by vision wskazało venue_match (do którego z nich pasuje to menu). Pusto = brak listy. */
  nearbyVenues?: { name: string; cuisine?: string | null }[];
}

/** Pozycja wyłuskana ze strumienia — do podglądu (mini-karty) i wczesnego dociągania zdjęć. */
export interface ScanItemStub {
  /** Stabilne id RENDEROWE (pipeline) — ustawiane przy emisji enrich-item po scaleniu struktury; przy
   *  „live" tickerze struktury jeszcze nieznane (undefined). Apka aktualizuje slot po nim. */
  id?: string;
  original: string;
  /** Kanoniczna nazwa dania (EN, z kontekstem grupy) = TOŻSAMOŚĆ. Apka kluczuje po niej merge enrich (odporne na
   *  powtórzone `original`, np. dwa „Mango": lunch=mango curry vs drink=mango lemonade). Pusty gdy brak. */
  full_name: string;
  /** Kanoniczny EN „dodatkowy opis" (istotne wyróżniki) ZE STRUKTURY — część KLUCZA cache enrichu (obok full_name).
   *  Niesiony w strumieniu, by rolling enrich liczył pod TYM SAMYM kluczem co finał (inaczej fd="" → cache MISS →
   *  finał liczy od nowa = podwójny koszt). "" gdy brak wyróżników. */
  fullDescription?: string;
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
function emitNewItems(text: string, state: { emitted: number }, onItem: (i: ScanItemStub) => void, idPrefix?: string): void {
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
            // id = porządek dokumentu (0-based); ten SAM schemat nadaje finalne Menu → rolling enrich trafia w slot.
            id: idPrefix ? `${idPrefix}${found - 1}` : undefined,
            original: o.original,
            full_name: typeof o.full_name === "string" && o.full_name ? o.full_name : o.original,
            fullDescription: typeof o.full_description === "string" ? o.full_description : "",
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
  "NAJPIERW ustal kontekst i zapisz go w polu `cuisine`: rodzaj kuchni jako KRÓTKI, KANONICZNY",
  "termin PO ANGIELSKU, małymi literami (np. 'indian', 'spanish', 'italian', 'fusion', 'sushi') —",
  "tak jak typy Google; ORAZ — na własny użytek — kraj i miasto lokalu (z nazw dań,",
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
  "Dla pola `photo_query` podaj KANONICZNĄ, ROZPOZNAWALNĄ nazwę dania do szukania zdjęć (zromanizowaną) —",
  "MINIMUM słów (zwykle 2–3), tak jak LUDZIE WYSZUKUJĄ to danie, z typem dania dla jednoznaczności (np.",
  "'mango chicken curry', 'pad thai noodles', 'patatas bravas', 'acai bowl', 'frappe coffee'). NIE rozwlekaj",
  "składnikami ('… with fruits and granola') ani kuchnią/narodowością ('indian', 'brunch cafe') — krótka,",
  "celna nazwa trafia LEPIEJ (też w wyszukiwarki tytułowe jak Wikimedia). Nie używaj markowej/lokalnej nazwy z menu",
  "(WYJĄTEK: pozycje `branded:true` — tam ZACHOWAJ nazwę marki, patrz niżej).",
  "Dla pola `photo_query_local` podaj nazwę dania do szukania zdjęć W JĘZYKU KRAJU, w którym jest",
  "lokal (kraj z lokalizacji/kontekstu) — tak jak ludzie szukają tego dania w tym kraju. Gdy język",
  "menu = język kraju, zwykle = original; gdy menu jest w innym języku (np. po angielsku, a lokal",
  "w Polsce), podaj nazwę w języku kraju (np. 'kurczak maślany'). Gdy się nie da — powtórz photo_query.",
  "Pole `branded` ustaw na true dla MARKOWYCH/paczkowanych produktów o znanym, stałym wyglądzie",
  "(Coca-Cola, Sprite, Fanta, butelkowana woda, gotowy batonik, a TAKŻE butelkowane/puszkowe PIWA, ALKOHOLE i napoje",
  "markowe — również lokalne marki, np. 'Bombay Sapphire', 'Jack Daniel's', lokalne piwo z nazwą) — wtedy lepsze jest",
  "generyczne zdjęcie produktu niż zdjęcie z lokalu. Dla potraw przyrządzanych w kuchni ustaw false.",
  "Dla `branded:true`: `photo_query` ZACHOWAJ NAZWĘ MARKI + formę (np. 'Bombay Sapphire gin bottle', 'Coca-Cola can'),",
  "a `description` rób krótko i FAKTYCZNIE (typ + marka), bez wymyślania receptury; składniki/alergeny tylko gdy pewne.",
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
  // ROLA + WIERNY ODCZYT
  "Jesteś precyzyjnym transkryptorem menu restauracji i tłumaczem. Dostajesz 1+ zdjęć TEGO SAMEGO menu (czasem też",
  "okładkę/szyld/witrynę/wizytówkę/paragon). Odczytaj TYLKO to, co realnie widać — nie wymyślaj pozycji. Wypisz",
  "WSZYSTKIE pozycje z podziałem na sekcje, w kolejności jak na stronach.",
  "ŁĄCZENIE UJĘĆ: zdjęcia często nachodzą na siebie lub pokazują wersje wielojęzyczne — to samo danie z różnych",
  "ujęć/języków = JEDEN wpis (uzupełnij braki z lepszego ujęcia, NIE duplikuj). `original` w języku oryginału menu.",
  // SEDNO: DWA RODZAJE PÓL
  "Każda pozycja ma DWA RODZAJE pól — NIE myl ich:",
  "(A) WIERNE KARCIE — przepisujesz to, co widać, NIC nie dodajesz z głowy: `original` (nazwa DOKŁADNIE jak na menu),",
  "`menu_description` (opis NADRUKOWANY pod/obok pozycji, słowo w słowo; '' gdy brak), `source_text` (cała linijka/blok",
  "z karty), `price`/`currency` (gdy widać; inaczej null), oraz `full_description` = zwięzły ANGIELSKI skrót DODATKOWYCH",
  "detali, które KARTA realnie podaje ponad nazwę (skład/dodatki/podanie/wariant: 'z boczkiem i jajkiem' → 'with bacon,",
  "fried egg'; '350 ml' → '350ml'); '' gdy karta podaje samą nazwę. W polach (A) NIE dopisuj wiedzy ogólnej o daniu.",
  "(B) USTALASZ SAM z wiedzy i KONTEKSTU — tu MASZ MYŚLEĆ, nie tylko przepisywać: `full_name`, `translated`, `cuisine`.",
  // full_name — serce
  "`full_name` = KANONICZNA, ANGIELSKA, KOMPLETNA nazwa = Twoja IDENTYFIKACJA, CZYM danie JEST. Ustal ją z KONTEKSTU:",
  "nagłówka sekcji, dań OBOK (czego pozycja jest wariantem), kuchni lokalu, wspólnych adnotacji sekcji (np. wybór białka",
  "'paneer/kurczak/warzywa/ryba', 'do tego ryż i naan', cena lunchu). Skrótowa/niejednoznaczna nazwa bierze sens Z",
  "KONTEKSTU, nie dosłownie: indyjskie 'Butter' → 'butter curry' (NIE masło/ghee), 'Mango' jako danie → 'mango curry'",
  "(NIE owoc), 'Korma'/'Madras'/'Tikka Masala' → '… curry', 'Margherita' pod Pizze → 'margherita pizza', 'Kawa'+'z",
  "mlekiem' → 'coffee with milk', 'Lassi'+'Mango' → 'mango lassi'. Gdy nazwa już pełna — podaj jej angielski kanon.",
  "Zachowaj KOLEJNOŚĆ słów (znaczenie!). BEZ rozmiaru/ilości w full_name (np. '1 litr', '250 ml') — te idą do `portion`.",
  // translated + cuisine
  "`translated` = nazwa dania w JĘZYKU DOCELOWYM, KOMPLETNA i zrozumiała (oddaj sens z kontekstu, nie tłumacz dosłownie",
  "samego skrótu). Przetłumacz też `name_translated` (sekcja), `text_translated` (adnotacja), `menu_description_translated`",
  "(wierne tłumaczenie opisu z karty; '' gdy brak). `cuisine` = krótki, kanoniczny termin PO ANGIELSKU, małymi literami",
  "(np. 'spanish'/'indian'/'sushi').",
  // portion + warianty
  "`portion` = rozmiar/gramatura/ilość DOKŁADNIE z karty ('250 ml', '200 g', '1 litr', '6 szt.'), z jednostką; '' gdy",
  "karta nie podaje. WARIANTY (kilka cen: mała/duża, kieliszek/butelka, 0,3/0,5 l) = JEDNA pozycja: wypełnij `variants`",
  "[{label, price}] i `price`=null; nie rozbijaj na osobne dania dla samych rozmiarów. Dodatki/dopłaty do wyboru",
  "('+2 ekstra ser') → do `menu_description`, nie jako osobne dania.",
  // zestawy
  "ZESTAWY / MENU DNIA ('Menú del día', lunch, zestaw obiadowy): CAŁY zestaw to JEDNA sekcja, której `title` = NAZWA",
  "zestawu z karty (np. 'Menú del Día — Viernes', 'Menu dnia', 'Lunch') — ZAWSZE wypełnij ten tytuł, nie zostawiaj pustego.",
  "NAWET gdy karta dzieli wybór na pod-nagłówki KURSÓW (PRIMEROS/SEGUNDOS/POSTRES,",
  "Przystawki/Główne/Desery, Starters/Mains/Desserts) — te pod-nagłówki to NIE osobne sekcje, tylko wartość `course`.",
  "Każde danie do wyboru = OSOBNA pozycja w tej JEDNEJ sekcji: `course`='1. danie'/'2. danie'/'deser' (wg pod-nagłówka),",
  "`price`=null, `surcharge` przy dopłatach ('+6,80€'). Cenę zestawu + co wliczone + dzień/zasady (po jednym z każdego",
  "kursu) → JEDNA adnotacja `kind='set'` ze `scope='section'` przy tej sekcji (NIE rozbijaj na osobne notatki `menu`).",
  "Zestaw bez wyboru (1-2 stałe pozycje) — wystarczy adnotacja.",
  // notes + availability
  "Teksty NIE-dania (czas oczekiwania, dopłaty/serwis/cover, VAT, napiwek, godziny, min. zamówienie, ogólne uwagi o",
  "alergenach, info dla całej grupy typu 'do każdego dania sałatka'/'w cenie pieczywo') → tablica `notes`, NIGDY jako",
  "pozycje: {`text`, `text_translated`, `scope` ('menu'|'section'), `section_index` (od 0 gdy 'section', inaczej null),",
  "`kind` (set/included/wait/fee/tax/tip/hours/info)}. NIE wrzucaj tu nazwy/tytułu lokalu (→ `restaurant_name`). Brak adnotacji → `notes` puste. Ograniczenia czasowe sekcji",
  "(menu dnia w tygodniu, brunch weekendowy, karta sezonowa) → KRÓTKO w `availability` sekcji ('pn-pt 13-16', 'weekend');",
  "brak → null.",
  // meta + readable
  "META: `restaurant_name`/`restaurant_address` — szukaj też na okładce/szyldzie/witrynie/wizytówce/paragonie/stopce (ze",
  "zdjęcia BEZ dań NIE twórz pozycji, `sections` puste dla niego, ale ZWRÓĆ nazwę/adres i `readable=true`).",
  "KRÓTKI TYTUŁ u góry tablicy/karty NAD daniami to nazwa lokalu — NAWET tuż przy logo sponsora-napoju (Estrella Damm/Mahou/Coca-Cola) i NAWET gdy zawiera słowo kuchni (odręczne 'Tapas 23', 'Pizzeria Roma', 'Sushi Bar') — wpisz go do `restaurant_name`, NIE do `notes`; samo graficzne logo marki napoju to sponsoring, nie nazwa.",
  "Jeśli nazwy lokalu nie wypisano WPROST, WYPROWADŹ ją z domeny/adresu www/e-maila/uchwytu social na karcie",
  "(np. 'www.centrum.indiantaste.com.pl' → 'Indian Taste'; odetnij www/TLD i człony generyczne: centrum/restauracja/menu/sklep/online). To pole jest NIEZALEŻNE od listy 'w pobliżu' — podaj nazwę z karty NAWET gdy venue_match=null.",
  "ALE NIE wyprowadzaj nazwy z platform/agregatorów dostaw ani z sieci social (pyszne.pl, ubereats, glovo, wolt, bolt, deliveroo, tripadvisor, facebook, instagram, google, linktr.ee) — to NIE jest nazwa lokalu; w razie wątpliwości daj null.",
  "`restaurant_language` = ISO 639-1. `readable=false` TYLKO gdy nie da się odczytać NICZEGO (mocno rozmazane/ciemne/",
  "ucięte) ANI nazwy lokalu — wtedy `sections` puste; samo 'to nie menu' to ZA MAŁO. `low_quality=true` gdy częściowo",
  "czytelne, ale odczyt niepełny/niepewny (i tak wypisz, co się da); przy pełnym, wyraźnym odczycie `low_quality=false`.",
].join(" ");

// PRZEBIEG 2 — TEKST, WSADOWO. PO RE-ARCHITEKTURZE: enrich generuje WYŁĄCZNIE GENERYCZNĄ WIEDZĘ o daniu
// (opis 'czym jest', składniki, alergeny, kategoria, dieta, ostrość, nazwa lokalna, branded) — NIC NIE TŁUMACZY
// (tłumaczenia robi skan). Pozycja identyfikowana przez kanoniczną nazwę (`full_name`) → cache po niej.
export const ENRICH_SYSTEM = [
  "Jesteś ekspertem kulinarnym. Dostajesz LISTĘ dań (kanoniczna nazwa + ewentualne ISTOTNE WYRÓŻNIKI po '|' + numer `index`)",
  "oraz kontekst kuchni i kraju. Dla KAŻDEJ pozycji zwróć GENERYCZNĄ wiedzę o tym typie dania po jej `index`.",
  "NIE tłumacz nazw (to już zrobione). Wszystko MUSI pasować do podanej kuchni i regionu.",
  "Gdy po '|' są ISTOTNE WYRÓŻNIKI (nietypowy skład/podanie TEGO wykonania) — UWZGLĘDNIJ je w `description` i `ingredients`,",
  "żeby oddać co dane danie naprawdę zawiera (a nie sam ogólnik). Gdy ich brak — opisz typowe wykonanie dania.",
  "`description`: ZWIĘŹLE (1 zdanie, max 2) i RZECZOWO wyjaśnij CZYM JEST danie — składniki, podanie, kontekst",
  "kulinarny w TEJ kuchni/regionie. Pisz w JĘZYKU DOCELOWYM (podanym w prompcie). NIE upiększaj, NIE dodawaj",
  "nietypowych składników (np. NIE dodawaj awokado do zwykłej zielonej sałatki). Lepiej ogólnie i PRAWDZIWIE.",
  "W `ingredients` tylko składniki pewne/typowe (w języku docelowym).",
  "`dietary` — przy NIEPEWNOŚCI odpowiadaj ZACHOWAWCZO (na korzyść BEZPIECZEŃSTWA gościa, NIE optymistycznie): oznaczaj",
  "`true` TYLKO gdy danie typowo NA PEWNO spełnia warunek. Dwuznaczne białko (samo 'curry'/'korma'/'biryani'/'masala'/",
  "'kebab'/'tikka' bez podanego mięsa LUB warzyw) → domyślnie wariant MIĘSNY: vegetarian=false, vegan=false. `vegan=true`",
  "tylko bez nabiału/jaj/miodu (śmietana, masło, ghee, jogurt, ser, panir, miód, ryby/sos rybny → vegan=false). `gluten_free`",
  "=false gdy typowo jest pszenica/gluten (naan, chlebki, makaron, panierka, sos sojowy, pieczywo, piwo).",
  "`allergens` — w DRUGĄ stronę: wymień WSZYSTKIE prawdopodobne (lepiej OSTRZEC niż pominąć).",
  "`category` z dozwolonej listy. `spice_level` 0–3 = TYPOWA ostrość dania w tej kuchni (nie domyślnie 0, gdy danie bywa ostre).",
  "`photo_query`: NAJLEPSZY termin do wyszukania REPREZENTATYWNEGO zdjęcia tego dania (angielski, zromanizowany).",
  "Zastanów się, jaki termin trafi PODOBNĄ, gotową potrawę: dość konkretny, by to było TO danie, ale NIE zawężaj",
  "nadmiernie — BEZ rozmiarów/ilości ('1 litr', '250 ml') i bez długich list składników. Dla NAPOJÓW dodaj FORMĘ,",
  "gdy poprawia trafienie ('bottle', 'glass', 'can') — butelka wygląda inaczej niż szklanka. Celuj w podaną porcję.",
  "`photo_query_local`: nazwa dania do zdjęć W JĘZYKU KRAJU lokalu (jak ludzie tam szukają tej potrawy). Gdy się nie da",
  "— powtórz nazwę kanoniczną. Celuj w GOTOWĄ, PODANĄ potrawę (jak na talerzu), nie w surowe składniki/opakowanie/przepis.",
  "`branded`: true dla MARKOWYCH/paczkowanych produktów o stałym wyglądzie — NIE tylko Coca-Cola/woda, ale też butelkowane/puszkowe PIWA, ALKOHOLE i napoje markowe, TAKŻE lokalne marki (np. 'Bombay Sapphire', 'Jack Daniel's', lokalne piwo z nazwą); false dla potraw przyrządzanych w lokalu.",
  "DLA POZYCJI `branded:true` NIE FABRYKUJ: `description` = krótka FAKTYCZNA nota (typ produktu + marka, np. 'gin markowy', 'cola gazowana'), BEZ wymyślania receptury/pochodzenia/historii; `ingredients`/`allergens` tylko gdy POWSZECHNIE znane dla TEGO produktu, inaczej PUSTE; nie zgaduj `dietary`/`spice_level` (zostaw zachowawczo/puste). `photo_query` dla branded ZACHOWAJ NAZWĘ MARKI + formę (np. 'Bombay Sapphire gin bottle', 'Coca-Cola can') — WYJĄTEK od reguły 'opisowo, bez marki', bo chcemy trafić DOKŁADNIE ten produkt.",
].join(" ");

// Wspólny blok instrukcji kontekstowej (ten sam dla Claude i OpenAI).
export function contextText(opts: ExtractOptions, n: number): string {
  return (
    `Język docelowy: ${opts.targetLang}.\n` +
    `Lokal (podpowiedź): ${opts.restaurantHint ?? "nieznany"}.\n` +
    (opts.nameGuess
      ? `Możliwa nazwa lokalu odczytana z SZYLDU/frontu (NIEPEWNA — OCR mógł się pomylić lub to nie ten lokal): „${opts.nameGuess}". ` +
        `Użyj jej do pola restaurant_name TYLKO jeśli zgadza się z tym, co widać na karcie menu; jeśli karta wskazuje inną nazwę lub tej nie potwierdza — ZIGNORUJ tę podpowiedź.\n`
      : "") +
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
      // Determinizm odczytu menu (wierniejsza transkrypcja + stabilny cache). Modele reasoning (gpt-5*) nie przyjmują temperature.
      ...(supportsTemperature(model) ? { temperature: 0 } : {}),
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
        if (opts.onItem) emitNewItems(acc, itemState, opts.onItem, opts.idPrefix);
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

/** Klucz ŹRÓDŁOWY zestawu: STABILNE hashe (md5 oryginału z telefonu), kolejność ma znaczenie. Zwraca null,
 *  gdy KTÓREKOLWIEK zdjęcie nie ma srcHash → nie cache'ujemy struktury (stary klient/lab bez hasha). */
function srcKey(images: InputImage[]): string | null {
  if (!images.length || !images.every((im) => im.srcHash)) return null;
  return images.map((im) => im.srcHash).join("+");
}

// Odtwarza licznik pozycji i nazwy z gotowej struktury (cache) — apka pokazuje to samo, co przy realnym
// odczycie. photoQuery puste → apka NIE prefetchuje (zrobi to po enrich z dobrym hasłem).
function replayStructureItems(structure: MenuStructure, opts: ExtractOptions): void {
  // Z cache też zgłoś KUCHNIĘ (jak streaming) — apka potrzebuje DETERMINISTYCZNEJ kuchni ze struktury do
  // STABILNEGO klucza cache enrichu/zdjęć. Bez tego re-skan szedł z niestabilnym peek → cache nie trafiał.
  if (structure.cuisine) opts.onMeta?.({ cuisine: structure.cuisine });
  if (!opts.onProgress && !opts.onItem) return;
  let n = 0;
  for (const s of structure.sections) for (const it of s.items) {
    n++;
    opts.onItem?.({ original: it.original, full_name: it.full_name || it.original, fullDescription: it.full_description || "", translated: it.translated || it.original, photoQuery: it.full_name || "", photoQueryLocal: "", branded: false, description: it.menu_description || "", price: it.price, currency: it.currency });
  }
  opts.onProgress?.({ chars: 0, items: n });
}

// Kontekst dla PRZEBIEGU 1 (struktura): język docelowy (skan tłumaczy treści z karty + tworzy full_name);
// lokalizacja/kuchnia pomagają poprawnie odczytać i kanonizować lokalne nazwy dań.
export function contextTextStructure(opts: ExtractOptions, n: number): string {
  return (
    `Język docelowy tłumaczeń (translated/name_translated/text_translated/menu_description_translated): ${opts.targetLang}.\n` +
    `Lokal (podpowiedź): ${opts.restaurantHint ?? "nieznany"}.\n` +
    (opts.locationHint ? `Lokalizacja lokalu (GPS): ${opts.locationHint}.\n` : "") +
    // Kuchni z peeku CELOWO nie podajemy — model lepiej ustali ją sam z pełnego menu; słaby peek tylko mieszał.
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

  // (Usunięty legacy cache „menu-scan" = pełne menu w jednym wpisie. Apka i tak idzie 2-fazowo: struktura
  //  (cache menu-structure) + enrich (cache item-enrich) — pełnego wpisu nie trzeba, ścieżka pełna i tak
  //  trafia w te dwa pod-cache i tylko składa wynik.)
  let total: Usage = ZERO_USAGE;
  // PRZEBIEG 1 — STRUKTURA (vision). Streaming nazw przez onItem/onProgress (apka pokazuje pozycje na żywo).
  // Cache struktury per STABILNY hash źródłowy (md5 oryginału z telefonu) + model. Hash liczony z
  // NIEZMODYFIKOWANEGO zdjęcia (przed resize/JPEG) → nie zmienia się przez modyfikację → ponowny skan TEGO
  // SAMEGO zdjęcia (testy/replay, lab) trafia → darmowy odczyt vision. Bez srcHash (stary klient) → null
  // klucz = nie cache'ujemy. knownSections (kolejne strony) → inny kontekst → dołącz do klucza.
  const sectCtx = opts.knownSections?.length ? opts.knownSections.join("|") : "";
  const baseKey = srcKey(images);
  // MODEL NIE w kluczu (osobna metadana). Klucz = srcHash [+ kontekst znanych sekcji].
  const sck = baseKey && (sectCtx ? cacheKey("menu-structure", baseKey, sectCtx) : cacheKey("menu-structure", baseKey));
  const canCache = !opts.noCache && !!sck;
  let structure = canCache ? await cacheGet<MenuStructure>("menu-structure", sck as string, { op: "scan" }) : null;
  const structureFromCache = structure !== null; // hit → skan bez kosztu modelu
  if (structure) {
    replayStructureItems(structure, opts); // odtwórz licznik/nazwy/kuchnię z cache (apka pokaże pozycje)
  } else {
    const s = usesOpenAiApi(model) ? await structureOpenAI(images, opts, model) : await structureClaude(images, opts, model);
    structure = s.structure;
    total = addUsage(total, s.usage);
    if (canCache) void cacheSet("menu-structure", sck as string, structure, { model });
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
    const sm = buildStructureMenu(structure);
    // Nadaj id w TYM SAMYM porządku dokumentu co stream (onItem) → rolling enrich/zdjęcia trafiają w slot po id.
    if (opts.idPrefix) { let o = 0; sm.sections.forEach((sec) => sec.items.forEach((it) => { it.id = `${opts.idPrefix}${o++}`; })); }
    return { menu: sm, usage: total, readable, poorQuality, enriched: false, cached: structureFromCache };
  }

  // PRZEBIEG 2 — WZBOGACANIE (tekst, z cache per pozycja) → pełne Menu.
  const enriched = await enrichMenu(structure, opts, enrichModel);
  total = addUsage(total, enriched.usage);
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
    // Determinizm odczytu menu — wierniejsza transkrypcja + stabilny cache. Opus 4.8 ma temperature ZDEPRECJONOWANE (400).
    ...(supportsTemperature(model) ? { temperature: 0 } : {}),
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
      if (opts.onItem) emitNewItems(snapshot, itemState, opts.onItem, opts.idPrefix);
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


// Wzbogacenie pojedynczej pozycji (wynik przebiegu 2) — cache'owane per pozycja.
// PO RE-ARCHITEKTURZE: enrich = tylko GENERYCZNA wiedza o daniu (bez tłumaczeń — te robi skan).
interface ItemEnrich {
  index: number;
  /** Najlepszy termin do WYSZUKANIA reprezentatywnego zdjęcia (dobrany pod trafność, z formą dla napojów). */
  photo_query: string;
  photo_query_local: string;
  branded: boolean;
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
  const fullName = it.full_name || it.original; // tożsamość: kanoniczna EN nazwa (ze skanu)
  return {
    id: it.id, // stabilne id renderowe (pipeline) — przenoszone ze struktury, undefined poza pipeline
    original: it.original,
    translated: it.translated || it.original, // tłumaczenie robi SKAN
    full_name: fullName,
    full_description: it.full_description || "",
    portion: it.portion || undefined,
    source_text: it.source_text || it.original,
    photo_query: e?.photo_query || fullName, // termin do zdjęć: dobrany przez enrich (forma dla napojów), fallback = full_name
    photo_query_local: e?.photo_query_local || e?.photo_query || fullName,
    branded: e?.branded ?? false,
    menu_description: it.menu_description || "",
    menu_description_translated: it.menu_description_translated || "", // tłumaczenie opisu z karty robi SKAN
    description: e?.description || it.menu_description || "",
    ingredients: e?.ingredients ?? [],
    allergens: e?.allergens ?? [],
    category,
    dietary: e?.dietary ?? { vegetarian: false, vegan: false, gluten_free: false },
    spice_level: spice,
    price: it.price,
    currency: it.currency,
    variants: it.variants?.length ? it.variants : undefined,
    course: it.course ?? undefined,
    surcharge: it.surcharge ?? undefined,
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
      name_translated: s.name_translated || s.name,
      availability: s.availability ?? undefined,
      items: s.items.map((it) => assembleItem(it, null)),
    })),
    notes: (structure.notes ?? []).map((n) => ({ text: n.text, text_translated: n.text_translated || n.text, scope: n.scope, section_index: n.section_index, kind: n.kind })),
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
      name_translated: s.name_translated ?? s.name,
      availability: s.availability ?? null,
      items: s.items.map((it) => ({ id: it.id, original: it.original, translated: it.translated ?? it.original, full_name: it.full_name ?? it.original, full_description: it.full_description ?? "", portion: it.portion ?? "", menu_description: it.menu_description ?? "", menu_description_translated: it.menu_description_translated ?? "", source_text: it.source_text ?? "", price: it.price, currency: it.currency, variants: it.variants ?? [], course: it.course ?? null, surcharge: it.surcharge ?? null })),
    })),
    notes: (menu.notes ?? []).map((n) => ({ text: n.text, text_translated: n.text_translated ?? n.text, scope: n.scope, section_index: n.section_index, kind: n.kind })),
    readable: true,
    low_quality: false,
  };
}

/** Klucz z OPISU Z KARTY: deaccent+lower, rozbicie na elementy listy (po przecinku/średniku/slashu) →
 *  POSORTOWANE (opis składników to ZBIÓR — kolejność nieistotna, „ser, szynka" == „szynka, ser") → reużycie
 *  cross-restauracja. Brak opisu → "" (pełne reużycie pozycji bez opisu). Prozę (bez przecinków) zostawia bez zmian. */
function descSortKey(md: string): string {
  const t = md.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  if (!t) return "";
  return t.split(/[,;/]+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).sort().join(", ");
}

interface EnrichResult { items: ItemEnrich[]; usage: Usage }

// Z (jeszcze niepełnego) strumienia JSON enrichu wyłuskuje KOMPLETNE obiekty z tablicy `items` i emituje
// każdy OD RAZU po domknięciu (jak emitNewItems dla vision) → enrich-item lecą PO JEDNYM, nie partią. Świadome
// stringów/escape/zagnieżdżeń (dietary to obiekt). Emituje tylko NOWE (po liczniku). Niepełne pomija (dołapie finał).
function streamEnrichItems(text: string, state: { emitted: number }, onItem: (raw: ItemEnrich) => void): void {
  const ak = text.indexOf('"items"');
  if (ak < 0) return;
  const br = text.indexOf("[", ak);
  if (br < 0) return;
  let count = 0, depth = 0, inStr = false, esc = false, objStart = -1;
  for (let p = br + 1; p < text.length; p++) {
    const ch = text[p]!;
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") { if (depth === 0) objStart = p; depth++; }
    else if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && objStart >= 0) {
        count++;
        if (count > state.emitted) {
          try { const raw = JSON.parse(text.slice(objStart, p + 1)) as ItemEnrich; if (typeof raw.index === "number") { onItem(raw); state.emitted = count; } }
          catch { /* obiekt jeszcze niedomknięty / niepełny — złapie się przy kolejnym snapshocie lub w bezpieczniku */ }
        }
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) break; // koniec tablicy items
  }
}

/** Jedno tekstowe wywołanie wzbogacające (Claude/OpenAI): dla podanych pozycji (identyfikowanych przez
 *  `full_name` — kanoniczna EN) zwraca GENERYCZNĄ wiedzę o daniu. Tłumaczenia robi już skan — tu ich nie ma.
 *  `onStreamItem` (Claude): woła per danie GDY TYLKO domknie się w strumieniu → emisja po jednym, nie partią. */
async function enrichCall(
  model: ModelId,
  opts: ExtractOptions,
  cuisine: string,
  country: string | undefined,
  items: { gi: number; fullName: string; fd: string }[],
  onStreamItem?: (raw: ItemEnrich) => void,
): Promise<EnrichResult> {
  const ctx =
    `Kuchnia: ${cuisine}.\n` +
    (country ? `Kraj/region lokalu: ${country}.\n` : "") +
    (opts.locationHint ? `Lokalizacja: ${opts.locationHint}.\n` : "") +
    (opts.restaurantHint ? `Lokal: ${opts.restaurantHint}.\n` : "") +
    `Język docelowy: ${opts.targetLang}.\n\n`;
  // INDEKS = pozycja na PODANEJ niżej liście (GĘSTE 0..N-1), NIE numer globalny. Mapowanie z powrotem na
  // właściwe danie robi wywołujący przez items[index].gi — odporne, gdy model odda przesunięte indeksy.
  // Po „|" (gdy jest) idą ISTOTNE WYRÓŻNIKI dania (full_description, kanoniczny EN) — model ma je wykorzystać do trafniejszego opisu.
  const itemsTxt = "POZYCJE (index → danie | istotne wyróżniki) do wzbogacenia o GENERYCZNĄ wiedzę:\n" + items.map((it, i) => `[${i}] ${it.fullName}${it.fd ? ` | ${it.fd}` : ""}`).join("\n");
  const userText = ctx + itemsTxt +
    "\n\nDla KAŻDEGO podanego indeksu zwróć wzbogacenie (opis CZYM JEST danie + składniki/alergeny/kategoria/dieta/ostrość + nazwa lokalna do zdjęć + branded), używając DOKŁADNIE tych samych numerów index z listy powyżej." +
    // Przypomnienie dietary NA KOŃCU (recency) — słabsze modele (Haiku) bywały zbyt optymistyczne (dwuznaczne curry
    // jako vegetarian=true). Egzekwujemy odpowiedź bezpieczną dla gościa, zgodną z regułami w systemie.
    "\n\n⚠ DIETARY — przy niepewności odpowiadaj ZACHOWAWCZO (bezpiecznie dla gościa, NIE optymistycznie): dwuznaczne białko (np. 'curry'/'korma'/'biryani' bez podanego mięsa/warzyw) → vegetarian=false, vegan=false; nabiał/jaja/miód → vegan=false; pszenica (naan/makaron/panierka) → gluten_free=false. Alergeny wymieniaj SZEROKO. Nie zgaduj na korzyść 'wege/vegan/bezglutenowe'." +
    // Egzekucja języka NA KOŃCU (recency) + po angielsku jako meta-dyrektywa — słabsze modele (Haiku) potrafiły
    // zignorować „Język docelowy" i odpowiedzieć po polsku (językiem promptu) dla ES/ZH; ta klauzula to naprawia.
    `\n\n⚠ OUTPUT LANGUAGE — write ALL \`description\` and \`ingredients\` values ONLY in ${opts.targetLang}. ` +
    `Respond ONLY in ${opts.targetLang}, even though these instructions are written in Polish. ` +
    `Do NOT use Polish or English unless ${opts.targetLang} IS Polish or English. (photo_query stays English.)`;

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
    else params.temperature = 0; // determinizm (modele reasoning nie przyjmują temperature)
    const resp = await track(tag, "enrich", () => openai.chat.completions.create(params));
    const usage = usageFromOpenAI(model, resp.usage);
    recordUsage(tag, usage.inputTokens, usage.outputTokens, usage.costUsd, model);
    logUsage(`enrich pozycji=${items.length} (${tag})`, model, usage);
    const txt = resp.choices[0]?.message?.content;
    const parsed = txt ? (JSON.parse(txt) as Partial<EnrichResult>) : {};
    return { items: parsed.items ?? [], usage };
  }

  // Streaming — duże menu daje duże wyjście; non-stream przy wysokim max_tokens odpala guard SDK. Strumień to omija.
  const stream = client.messages.stream({
    model,
    max_tokens: MODELS[model].maxOutput,
    // Determinizm: ten sam danie → ta sama wiedza → stabilny klucz cache. Opus 4.8: temperature zdeprecjonowane (400).
    ...(supportsTemperature(model) ? { temperature: 0 } : {}),
    system: [{ type: "text", text: ENRICH_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
    output_config: { format: { type: "json_schema", schema: ENRICH_SCHEMA } },
  });
  // PER-DANIE NA ŻYWO: parsuj strumień i emituj każde danie od razu po domknięciu (zamiast całą partią na końcu).
  if (onStreamItem) { const seen = { emitted: 0 }; stream.on("text", (_d: string, snap: string) => streamEnrichItems(snap, seen, onStreamItem)); }
  const resp = await track("claude", "enrich", () => stream.finalMessage());
  const usage = usageFrom(model, resp.usage);
  recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd, model);
  logUsage(`enrich pozycji=${items.length}`, model, usage);
  const t = resp.content.find((b) => b.type === "text");
  const parsed = t && t.type === "text" ? (JSON.parse(t.text) as Partial<EnrichResult>) : {};
  return { items: parsed.items ?? [], usage };
}

/**
 * PRZEBIEG 2 — wzbogacenie struktury w pełne Menu (tłumaczenia, photo_query, opisy itd.). Cache per
 * pozycja (`original+menu_desc + kuchnia + kraj + język + model`) i per nazwa sekcji — do modelu idą
 * TYLKO niezcache'owane pozycje. Składa wynik z bezpiecznymi fallbackami.
 */
// Single-flight WSADOWY enrich: koalescencja per (full_name+kontekst) między RÓWNOLEGŁYMI skanami (popularne dania
// na zimno → liczone RAZ; reszta bierze wynik, usage 0). Modułowy singleton współdzielony przez requesty.
const enrichInFlight = new BatchInFlight<ItemEnrich | null>();
export async function enrichMenu(structure: MenuStructure, opts: ExtractOptions, model: ModelId): Promise<{ menu: Menu; usage: Usage }> {
  const cuisine = structure.cuisine;
  const country = countryOf(opts.locationHint);
  // Klucz cache enrichu: lokalizacja na poziomie KRAJU (to samo danie w całym kraju dzieli wpis). Fallback "".
  const locKey = country || "";
  const langKey = langCode(opts.targetLang);

  // Płaska lista pozycji. TOŻSAMOŚĆ = `full_name` (kanoniczna EN nazwa) + `full_description` (kanoniczny EN
  // dodatkowy opis = istotne wyróżniki; "" gdy nic ważnego). Oba ZE SKANU → stabilne, dobrze reużywalne cross-menu.
  const flat: { fullName: string; fd: string }[] = [];
  const structByGi: StructItem[] = []; // równolegle do `flat` — do złożenia stuba enrich-item NA ŻYWO
  for (const s of structure.sections) for (const it of s.items) { flat.push({ fullName: it.full_name || it.original, fd: it.full_description || "" }); structByGi.push(it); }

  // KLUCZ: full_name + full_description (kanoniczny EN; descSortKey: listę składników po przecinku SORTUJE, bo to
  // zbiór → reużycie cross-restauracja; pusty gdy brak istotnych wyróżników = pełne reużycie) + kuchnia + kraj + język.
  const itemKey = (fullName: string, fd: string) => cacheKey("item-enrich", fullName, descSortKey(fd), cuisine, locKey, langKey);

  const enrichByGi = new Array<ItemEnrich | null>(flat.length).fill(null);
  // STRUMIEŃ NA ŻYWO: emituj enrich-item ZARAZ gdy pozycja gotowa (cache hit od razu, świeże po każdej partii) —
  // a NIE wszystkie naraz w finale (to powodowało „0/27 wisi… nagle 27/27" + zdjęcia hurtem). Apka łata po `id`.
  const emitEnrich = (gi: number) => {
    if (!opts.onEnrichItem) return;
    const mi = assembleItem(structByGi[gi]!, enrichByGi[gi] ?? null);
    opts.onEnrichItem({ id: mi.id, original: mi.original, full_name: mi.full_name || mi.original, translated: mi.translated, photoQuery: mi.photo_query, photoQueryLocal: mi.photo_query_local, branded: mi.branded, description: mi.description, price: mi.price, currency: mi.currency });
  };
  const needItems: { gi: number; fullName: string; fd: string }[] = [];
  if (!opts.noCache) {
    await Promise.all(flat.map(async (f, gi) => {
      const hit = await cacheGet<ItemEnrich>("item-enrich", itemKey(f.fullName, f.fd), { op: "enrich" });
      if (hit) enrichByGi[gi] = hit; else needItems.push({ gi, fullName: f.fullName, fd: f.fd });
    }));
  } else {
    flat.forEach((f, gi) => needItems.push({ gi, fullName: f.fullName, fd: f.fd }));
  }
  // Pozycje z cache są gotowe OD RAZU → wypuść je natychmiast (apka widzi postęp od pierwszej chwili).
  for (let gi = 0; gi < flat.length; gi++) if (enrichByGi[gi]) emitEnrich(gi);

  let usage = ZERO_USAGE;
  // SINGLE-FLIGHT WSADOWY (tryb cache): koalescencja per pozycję między RÓWNOLEGŁYMI skanami. MISS-y dzielimy na
  // OWNED (liczę ja) i BORROWED (inny skan już liczy ten sam danie+kontekst → biorę jego wynik, usage 0). Duplikaty
  // full_name w obrębie skanu też scalamy (jeden compute → wynik do wszystkich pozycji). noCache → bez koalescencji.
  const keyToEntries = new Map<string, { gi: number; fullName: string; fd: string }[]>();
  for (const ni of needItems) { const k = itemKey(ni.fullName, ni.fd); let a = keyToEntries.get(k); if (!a) { a = []; keyToEntries.set(k, a); } a.push(ni); }
  const claimed = opts.noCache ? null : enrichInFlight.claim([...keyToEntries.keys()], () => null);
  const ownedNeed = (claimed ? claimed.owned : [...keyToEntries.keys()]).map((k) => keyToEntries.get(k)![0]!);
  if (ownedNeed.length || (claimed && claimed.borrowed.size)) {
    // BATCHOWANIE: duże menu w JEDNYM wywołaniu = wolny output + ryzyko ucięcia na max_tokens. Partie ~12, współbieżność ≤4.
    const ENRICH_BATCH = 12;
    const chunks: { gi: number; fullName: string; fd: string }[][] = [];
    for (let i = 0; i < ownedNeed.length; i += ENRICH_BATCH) chunks.push(ownedNeed.slice(i, i + ENRICH_BATCH));
    const acc: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let next = 0;
    // Zastosuj enrich `it` do WSZYSTKICH pozycji o tym kluczu; przy PIERWSZYM ustawieniu — domknij borrowerów + cache.
    const applyTo = (key: string, it: ItemEnrich, fallbackEntries: { gi: number }[]) => {
      let setAny = false;
      for (const e of (keyToEntries.get(key) ?? fallbackEntries)) if (enrichByGi[e.gi] == null) { enrichByGi[e.gi] = it; emitEnrich(e.gi); setAny = true; }
      if (setAny && !opts.noCache) { enrichInFlight.resolve(key, it); void cacheSet("item-enrich", key, it, { lang: opts.targetLang, model }); }
    };
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++]!;
        // emituj PO JEDNYM — gdy danie domknie się w strumieniu (nie czekamy aż wróci cała partia).
        const apply = (it: ItemEnrich) => { const tgt = chunk[it.index]; if (tgt) applyTo(itemKey(tgt.fullName, tgt.fd), it, [tgt]); };
        const r = await enrichCall(model, opts, cuisine, country, chunk, apply);
        acc.inputTokens += r.usage.inputTokens; acc.outputTokens += r.usage.outputTokens; acc.costUsd += r.usage.costUsd;
        // BEZPIECZNIK: cokolwiek strumień pominął (parse / model OpenAI bez per-item) — dolicz z autorytatywnego wyniku.
        for (const it of r.items) apply(it);
      }
    };
    // OWNED (moje partie) i BORROWED (cudze loty) RÓWNOLEGLE — sekwencyjnie groziłoby zakleszczeniem dwóch skanów
    // czekających na siebie nawzajem. Borrowed NIGDY nie wiszą (timeout→null w BatchInFlight); null = degraduj bez enrich.
    const workersP = Promise.all(Array.from({ length: Math.min(4, chunks.length) }, worker));
    const borrowedP: Promise<unknown> = claimed
      ? Promise.all([...claimed.borrowed].map(async ([key, p]) => {
          const it = await p;
          for (const e of (keyToEntries.get(key) ?? [])) if (enrichByGi[e.gi] == null) { if (it) enrichByGi[e.gi] = it; emitEnrich(e.gi); }
        }))
      : Promise.resolve();
    await workersP;
    if (claimed) enrichInFlight.settleRemaining(claimed.owned, () => null); // owned pominięte przez model → null → borrowerzy degradują
    await borrowedP;
    usage = acc;
  }

  // Tłumaczenia sekcji/notatek/nazw — JUŻ w strukturze (zrobił skan). Tu tylko składamy + dokładamy enrich.
  let gi = 0;
  const menu: Menu = {
    restaurant_name: structure.restaurant_name,
    restaurant_address: structure.restaurant_address,
    restaurant_language: structure.restaurant_language,
    cuisine: structure.cuisine,
    sections: structure.sections.map((s) => ({
      name: s.name,
      name_translated: s.name_translated || s.name,
      availability: s.availability ?? undefined,
      // enrich-item już wyemitowane NA ŻYWO (cache hit od razu / świeże po partii) — tu tylko składamy menu.
      items: s.items.map((it) => assembleItem(it, enrichByGi[gi++] ?? null)),
    })),
    notes: (structure.notes ?? []).map((n) => ({ text: n.text, text_translated: n.text_translated || n.text, scope: n.scope, section_index: n.section_index, kind: n.kind })),
  };
  return { menu, usage };
}

// ===== EKSPERYMENT: SKAN JEDNOFAZOWY (struktura + enrich w JEDNYM wywołaniu vision) ===========
// Hipoteza: model czytający menu może OD RAZU zwrócić tłumaczenia + krótkie opisy + photo_query itd.
// (to, co dziś robi osobny enrich) — oszczędza 1 wywołanie i kontekst. Wpięte jako DODATKOWA możliwość
// (extractMenuOnePass) + eksperyment w LABie do porównania z torem dwufazowym. Nie zmienia toru apki.
export const ONEPASS_SYSTEM = [
  "Jesteś precyzyjnym transkryptorem menu restauracji, a zarazem ekspertem kulinarnym i tłumaczem.",
  "W JEDNYM przejściu ze zdjęć: (1) odczytaj STRUKTURĘ menu oraz (2) OD RAZU przetłumacz i wzbogać każdą pozycję.",
  "— STRUKTURA —",
  "Otrzymasz jedno lub WIELE zdjęć — strony/fragmenty TEGO SAMEGO menu (czasem okładka/fasada/szyld). Odczytaj TYLKO to, co realnie widać; nie wymyślaj pozycji.",
  "Wyodrębnij WSZYSTKIE pozycje z podziałem na sekcje, w kolejności jak na stronach; NIE duplikuj powtórzonych nagłówków/pozycji. To samo danie z różnych ujęć = JEDEN wpis (połącz braki). Menu wielojęzyczne: jeden wpis, `original` w języku oryginału (kraju lokalu).",
  "Dla pozycji: `original` (dokładnie jak na menu), `source_text` (przepisany fragment karty), `price`/`currency` (gdy widać, inaczej null), `menu_description` (opis NADRUKOWANY na karcie — transkrypcja; brak → pusty).",
  "WARIANTY (mała/duża, kieliszek/butelka): JEDNA pozycja, wypełnij `variants` i `price`=null.",
  "ZESTAWY/MENU DNIA z wyborem dań: każdy wybór jako osobna pozycja z `course` ('1. danie'/'2. danie'/'deser'), `price`=null, ew. `surcharge`; cenę/zasady zestawu jako adnotacja kind='set' przy sekcji. `availability` sekcji dla ograniczeń czasowych.",
  "Teksty NIE-dania (czas oczekiwania, dopłaty, VAT, napiwek, godziny, wliczone dodatki) → `notes` (text, scope, section_index, kind), NIGDY jako pozycje.",
  "Odczytaj `restaurant_name`/`restaurant_address` (też z okładki/szyldu/wizytówki). `cuisine` = KRÓTKI kanoniczny termin PO ANGIELSKU, małymi literami. `restaurant_language` = ISO 639-1. `readable=false` tylko gdy nic nie da się odczytać; `low_quality=true` przy słabej, częściowej czytelności. `venue_match` gdy w prompcie była lista W POBLIŻU.",
  "— TŁUMACZENIE I WZBOGACENIE (równocześnie) —",
  "Dla KAŻDEJ pozycji i sekcji przetłumacz nazwy na język docelowy (`translated`, `name_translated`) oraz adnotacje (`text_translated`). Wszystko MUSI pasować do ustalonej kuchni i regionu lokalu.",
  "`menu_description_translated`: wierne tłumaczenie opisu z karty (gdy był), inaczej pusty. `description`: ZWIĘŹLE (1 zdanie, max 2), RZECZOWO czym jest danie — oprzyj na opisie z karty/typowym przyrządzaniu w tej kuchni; NIE upiększaj, nie dodawaj nietypowych składników.",
  "`photo_query`: KANONICZNA, rozpoznawalna nazwa potrawy (zromanizowana), MINIMUM słów (2-3), jak ludzie wyszukują (np. 'patatas bravas', 'mango chicken curry', 'caesar salad') — opisz CZYM danie jest, nie markową/lokalną nazwą; nie rozwlekaj składnikami ani narodowością. `photo_query_local`: w języku kraju lokalu. `branded`: true dla markowych/paczkowanych (Coca-Cola, woda butelkowana, a TAKŻE butelkowane/puszkowe piwa/alkohole/napoje markowe, też lokalne marki). DLA branded: `photo_query` ZACHOWAJ markę + formę ('Bombay Sapphire gin bottle', 'Coca-Cola can'), `description` krótka i faktyczna (typ+marka, bez wymyślania receptury), składniki/alergeny tylko gdy pewne.",
  "`ingredients` tylko pewne/typowe; `allergens`, `dietary`, `spice_level` szacuj zachowawczo; `category` z dozwolonej listy.",
].join(" ");

/** Kontekst jednofazowy: lokal/lokalizacja/W POBLIŻU (jak struktura) + język docelowy (jak enrich). */
function contextTextOnePass(opts: ExtractOptions, n: number): string {
  return (
    `Język docelowy (tłumaczenia/opisy): ${opts.targetLang}.\n` +
    `Lokal (podpowiedź): ${opts.restaurantHint ?? "nieznany"}.\n` +
    (opts.locationHint ? `Lokalizacja lokalu (GPS): ${opts.locationHint}.\n` : "") +
    (opts.nearbyVenues?.length
      ? `W POBLIŻU (z GPS) są te lokale:\n` +
        opts.nearbyVenues.map((v, i) => `  ${i}) ${v.name}${v.cuisine ? ` — ${v.cuisine}` : ""}`).join("\n") +
        `\nJeśli to menu należy do JEDNEGO z nich — wskaż go w venue_match (by='name' z karty; by='cuisine' tylko gdy jednoznaczne). Brak → null.\n`
      : "") +
    `Połącz powyższe ${n} zdjęć w JEDNO menu: odczytaj strukturę ORAZ od razu przetłumacz i wzbogać pozycje.`
  );
}

/** Normalizuje surową odpowiedź jednofazową do Menu (walidacja kategorii/ostrości/diety/notatek). */
function onePassToMenu(parsed: Record<string, any>): { menu: Menu; readable: boolean; lowQuality: boolean } {
  const cat = (c: unknown): DishCategory => ((DISH_CATEGORIES as readonly string[]).includes(c as string) ? (c as DishCategory) : "other");
  const spice = (s: unknown): 0 | 1 | 2 | 3 => (([0, 1, 2, 3] as unknown[]).includes(s) ? (s as 0 | 1 | 2 | 3) : 0);
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const menu: Menu = {
    restaurant_name: parsed.restaurant_name ?? null,
    restaurant_address: parsed.restaurant_address ?? null,
    restaurant_language: parsed.restaurant_language ?? "",
    cuisine: parsed.cuisine ?? "unknown",
    sections: arr<Record<string, any>>(parsed.sections).map((s) => ({
      name: s.name ?? "",
      name_translated: s.name_translated || s.name || "",
      availability: s.availability ?? undefined,
      items: arr<Record<string, any>>(s.items).map((it): MenuItem => ({
        original: it.original ?? "",
        translated: it.translated || it.original || "",
        full_name: it.full_name || it.original || "",
        full_description: it.full_description || "",
        portion: it.portion || undefined,
        source_text: it.source_text || it.original || "",
        menu_description: it.menu_description || "",
        menu_description_translated: it.menu_description_translated || "",
        photo_query: it.photo_query || it.full_name || it.original || "",
        photo_query_local: it.photo_query_local || it.photo_query || it.full_name || it.original || "",
        branded: it.branded === true,
        description: it.description || it.menu_description || "",
        ingredients: arr<string>(it.ingredients),
        allergens: arr<string>(it.allergens),
        category: cat(it.category),
        dietary: it.dietary && typeof it.dietary === "object"
          ? { vegetarian: !!it.dietary.vegetarian, vegan: !!it.dietary.vegan, gluten_free: !!it.dietary.gluten_free }
          : { vegetarian: false, vegan: false, gluten_free: false },
        spice_level: spice(it.spice_level),
        price: it.price ?? null,
        currency: it.currency ?? null,
        variants: Array.isArray(it.variants) && it.variants.length ? it.variants : undefined,
        course: it.course ?? undefined,
        surcharge: it.surcharge ?? undefined,
      })),
    })),
    notes: arr<Record<string, any>>(parsed.notes).map((n): MenuNote => ({
      text: n.text ?? "",
      text_translated: n.text_translated || n.text || "",
      scope: n.scope === "section" ? "section" : "menu",
      section_index: typeof n.section_index === "number" ? n.section_index : null,
      kind: ((NOTE_KINDS as readonly string[]).includes(n.kind) ? n.kind : "info") as NoteKind,
    })),
  };
  return { menu, readable: parsed.readable !== false, lowQuality: parsed.low_quality === true };
}

/**
 * EKSPERYMENT: skan JEDNOFAZOWY — jedno wywołanie vision zwraca pełne Menu (struktura + tłumaczenia +
 * opisy + photo_query). Odpowiednik extractMenu, ale bez osobnej fazy enrich. Bez cache (do porównań).
 */
export async function extractMenuOnePass(
  images: InputImage[],
  opts: ExtractOptions,
  model: ModelId,
): Promise<{ menu: Menu; usage: Usage; readable: boolean; poorQuality: boolean }> {
  if (images.length === 0) throw new Error("Brak zdjęć do przetworzenia.");
  const ctx = contextTextOnePass(opts, images.length);
  let jsonText: string | null = null;
  let usage: Usage = ZERO_USAGE;

  if (usesOpenAiApi(model)) {
    const openai = getClientForModel(model);
    const tag = apiTag(model);
    const parts: import("openai").OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    images.forEach((img, i) => {
      parts.push({ type: "text", text: `— Zdjęcie ${i + 1} z ${images.length} —` });
      parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
    });
    parts.push({ type: "text", text: ctx });
    const { text, usageRaw } = await track(tag, "scan-onepass", async () => {
      const stream = await openai.chat.completions.create({
        model,
        max_completion_tokens: MODELS[model].maxOutput,
        messages: [{ role: "system", content: ONEPASS_SYSTEM }, { role: "user", content: parts }],
        response_format: { type: "json_schema", json_schema: { name: "menu", strict: tag === "openai", schema: ONEPASS_SCHEMA as unknown as Record<string, unknown> } },
        stream: true,
        stream_options: { include_usage: true },
        ...(supportsTemperature(model) ? { temperature: 0 } : {}),
      });
      let acc = "";
      let uRaw: import("openai").OpenAI.Completions.CompletionUsage | undefined;
      for await (const chunk of stream) {
        const d = chunk.choices?.[0]?.delta?.content;
        if (d) acc += d;
        if (chunk.usage) uRaw = chunk.usage;
      }
      return { text: acc, usageRaw: uRaw };
    });
    usage = usageFromOpenAI(model, usageRaw);
    recordUsage(tag, usage.inputTokens, usage.outputTokens, usage.costUsd, model);
    recordBytes(tag, images.reduce((n, i) => n + i.base64.length, 0), text.length);
    logUsage(`one-pass obrazów=${images.length} (${tag})`, model, usage);
    jsonText = text;
  } else {
    const content: Anthropic.ContentBlockParam[] = [];
    images.forEach((img, i) => {
      content.push({ type: "text", text: `— Zdjęcie ${i + 1} z ${images.length} —` });
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } });
    });
    content.push({ type: "text", text: ctx });
    const stream = client.messages.stream({
      model,
      max_tokens: MODELS[model].maxOutput,
      ...(supportsTemperature(model) ? { temperature: 0 } : {}),
      system: ONEPASS_SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: ONEPASS_SCHEMA } },
    });
    const resp = await track("claude", "scan-onepass", () => stream.finalMessage());
    usage = usageFrom(model, resp.usage);
    recordUsage("claude", usage.inputTokens, usage.outputTokens, usage.costUsd, model);
    const t = resp.content.find((b) => b.type === "text");
    jsonText = t && t.type === "text" ? t.text : null;
    recordBytes("claude", images.reduce((n, i) => n + i.base64.length, 0), jsonText?.length ?? 0);
    logUsage(`one-pass obrazów=${images.length} (claude)`, model, usage);
  }

  if (!jsonText) throw new Error("Pusta odpowiedź modelu (skan jednofazowy).");
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, any>;
  } catch {
    throw new Error("Nie udało się odczytać menu (odpowiedź jednofazowa niepełna/ucięta).");
  }
  const { menu, readable, lowQuality } = onePassToMenu(parsed);
  return { menu, usage, readable, poorQuality: lowQuality };
}

/** Wygoda dla CLI: jeden plik ze ścieżki. */
export async function extractMenuFromFile(
  imagePath: string,
  opts: ExtractOptions,
): Promise<{ menu: Menu; usage: Usage }> {
  const base64 = (await readFile(imagePath)).toString("base64");
  return extractMenu([{ base64, mediaType: mediaTypeFor(imagePath) }], opts);
}
