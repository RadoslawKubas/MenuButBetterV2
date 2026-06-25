// JSON Schema wyniku odczytu menu (structured outputs Claude).
// Trzyma się ograniczeń structured outputs: każdy obiekt ma additionalProperties:false,
// wszystkie pola w `required`, pola opcjonalne są nullable (type: [..., "null"]).
// Bez minLength/maximum itp. — te ograniczenia nie są wspierane.

export const DISH_CATEGORIES = [
  "starter",
  "soup",
  "salad",
  "main",
  "side",
  "pasta",
  "pizza",
  "seafood",
  "dessert",
  "drink",
  "other",
] as const;

export type DishCategory = (typeof DISH_CATEGORIES)[number];

// Adnotacje menu, które NIE są daniami (czas oczekiwania, dopłaty, VAT, napiwek, godziny, zestawy,
// to-co-wliczone-w-grupie itp.).
export const NOTE_KINDS = ["set", "included", "wait", "fee", "tax", "tip", "hours", "info"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export interface StructNote {
  /** Treść adnotacji w oryginale (jak na menu). */
  text: string;
  /** Treść po przetłumaczeniu na język docelowy (robione w SKANIE — to treść z obrazu). */
  text_translated: string;
  /** Zakres: całe menu albo konkretna sekcja. */
  scope: "menu" | "section";
  /** Indeks sekcji (gdy scope="section"), inaczej null. */
  section_index: number | null;
  /** Typ do prezentacji: wait/fee/tax/tip/hours/info. */
  kind: NoteKind;
}
/** Adnotacja w gotowym menu = StructNote (tłumaczenie robi już skan). */
export type MenuNote = StructNote;

// Wspólny fragment schematu adnotacji (dla STRUCTURE i MENU single-pass).
const NOTE_SCHEMA_ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", description: "Treść adnotacji DOKŁADNIE jak na menu (oryginał)." },
    text_translated: { type: "string", description: "Treść adnotacji przetłumaczona na język docelowy (krótko, zachowaj sens)." },
    scope: { type: "string", enum: ["menu", "section"], description: "'menu' = dotyczy całego menu; 'section' = dotyczy KONKRETNEJ sekcji." },
    section_index: { type: ["integer", "null"], description: "Indeks sekcji (kolejność w 'sections', licząc od 0), gdy scope='section'. Inaczej null." },
    kind: { type: "string", enum: [...NOTE_KINDS], description: "Typ: set=ZESTAW/menu dnia (cena zestawu + co wliczone + co do wyboru), included=co dochodzi/jest wliczone do dań tej grupy (np. 'do każdego dania sałatka', 'w cenie pieczywo'), wait=czas oczekiwania, fee=dopłata/serwis/cover/taras, tax=VAT/podatek, tip=napiwek, hours=godziny, info=inne (np. 'ryż min. dla 2 osób', minimalne zamówienie, alergeny)." },
  },
  required: ["text", "text_translated", "scope", "section_index", "kind"],
} as const;
const NOTES_SCHEMA_DESC = "Adnotacje menu, które NIE są daniami: ZESTAWY/menu dnia (cena + skład + do wyboru), to co WLICZONE/dochodzi do dań danej grupy ('do każdego dania sałatka', 'w cenie pieczywo'), info o porcjach ('ryż min. dla 2 osób'), czas oczekiwania, dopłaty (taras/serwis/cover), VAT/podatek, napiwek, godziny, minimalne zamówienie, ogólne uwagi o alergenach. Gdy dotyczą KONKRETNEJ grupy/sekcji — ustaw scope='section' + section_index, żeby pokazać je pod nazwą tej grupy. NIE umieszczaj ich jako pozycje (dania). NIE wrzucaj tu NAZWY/TYTUŁU lokalu — krótki tytuł u góry karty/tablicy (np. 'Tapas 23') to `restaurant_name`, nie adnotacja. Gdy brak — pusta tablica.";

export interface MenuItem {
  /** Stabilne id RENDEROWE (nadane przez serwer po scaleniu struktury, np. „s0-i3"). Tożsamość pozycji w
   *  strumieniu pipeline — apka aktualizuje slot po nim (odporne na powtórzone nazwy). "" gdy poza pipeline. */
  id?: string;
  original: string;
  translated: string;
  /** Kanoniczna, angielska, kompletna nazwa (z kontekstem grupy) — tożsamość do enrich + zdjęć. */
  full_name?: string;
  /** Kanoniczny angielski „dodatkowy opis" (istotne wyróżniki) — wejście enrich + część klucza; "" gdy brak. */
  full_description?: string;
  /** Gramatura/pojemność/ilość porcji z karty (np. „250 ml", „200 g") — do wyświetlenia; "" gdy brak. */
  portion?: string;
  /** Fragment oryginalnej karty (przepisana linijka/blok), z którego pochodzi danie. */
  source_text?: string;
  /** Opis NADRUKOWANY na karcie (oryginał), gdy był. */
  menu_description?: string;
  /** Wierne tłumaczenie opisu z karty (gdy był) — pokazywane jako słowa lokalu. */
  menu_description_translated?: string;
  photo_query: string;
  photo_query_local: string;
  /** Markowy/paczkowany produkt (Coca-Cola, butelkowany napój) — lepszy generyczny produktowy shot. */
  branded: boolean;
  description: string;
  ingredients: string[];
  allergens: string[];
  category: DishCategory;
  dietary: { vegetarian: boolean; vegan: boolean; gluten_free: boolean };
  spice_level: 0 | 1 | 2 | 3;
  price: string | null;
  currency: string | null;
  /** Warianty cenowe (rozmiary/opcje) — gdy >1 ceny. Inaczej puste/undefined (jedna cena w `price`). */
  variants?: PriceVariant[];
  /** Grupa wyboru w zestawie (menu dnia): „1. danie"/„deser". Apka grupuje po tym w sekcji zestawu. */
  course?: string | null;
  /** Dopłata przy wyborze w zestawie (np. „+2 €"). */
  surcharge?: string | null;
}

export interface MenuSection {
  name: string;
  name_translated: string;
  items: MenuItem[];
  /** Ograniczenie czasowe sekcji (menu dnia/lunch/weekend/sezon), np. „pn-pt 13-16". Brak → undefined. */
  availability?: string | null;
}

export interface Menu {
  restaurant_name: string | null;
  restaurant_address: string | null;
  restaurant_language: string;
  cuisine: string;
  sections: MenuSection[];
  /** Adnotacje menu (czas oczekiwania, dopłaty, VAT…) — pokazywane osobno, nie jako dania. */
  notes?: MenuNote[];
}

// ===== DWUPRZEBIEGOWY SKAN ==================================================================
// Przebieg 1 (VISION, per zdjęcie): TYLKO to, co wymaga zobaczenia kartki — struktura, oryginalne
// nazwy, ceny i ewentualny opis NADRUKOWANY na menu (transkrypcja, nie generowanie). Mały output
// = taniej/szybciej/mniej ucięć, świetne recovery i cache per zdjęcie.
/** Wariant ceny (rozmiar/opcja): np. {label:"duża", price:"28"}. Pusta tablica = jedna cena (w `price`). */
export interface PriceVariant { label: string; price: string }
export interface StructItem {
  /** Stabilne id RENDEROWE (nadane po scaleniu struktury) — przenoszone do enrichu i zdjęć, by pipeline
   *  emitował zdarzenia po nim. Undefined poza torem pipeline. */
  id?: string;
  original: string;
  /** Tłumaczenie nazwy dania na język docelowy (robione w SKANIE — to treść Z OBRAZU). */
  translated: string;
  /** KANONICZNA, ANGIELSKA, KOMPLETNA nazwa dania (z kontekstem grupy) — tożsamość do enrich + zdjęć. */
  full_name: string;
  /** KANONICZNY, ANGIELSKI „dodatkowy opis" — ISTOTNE wyróżniki dania (skład/wykonanie) gdy są ważne;
   *  "" gdy nic istotnego do dodania. BEZ rozmiaru (ten w `portion`). Wejście enrich + część klucza. */
  full_description: string;
  /** Gramatura/pojemność/ilość porcji DOKŁADNIE z karty (np. „250 ml", „200 g", „1 litr", „6 szt."); "" gdy brak.
   *  Strukturalne, do WYŚWIETLENIA — NIE w kluczu enrich (porcja nie zmienia wiedzy o daniu). */
  portion: string;
  /** Opis WIDOCZNY na menu (transkrypcja), jeśli jest — inaczej "". Tylko do WYŚWIETLENIA (+ jego tłumaczenie). */
  menu_description: string;
  /** Wierne tłumaczenie opisu NADRUKOWANEGO na karcie (skan — treść z obrazu). Gdy brak — "". */
  menu_description_translated: string;
  /** Fragment ORYGINALNEJ karty (przepisana linijka/blok), z którego pochodzi danie — do podglądu. */
  source_text: string;
  price: string | null;
  currency: string | null;
  /** Warianty cenowe (rozmiary/opcje) — gdy >1 ceny; wtedy `price`=null. Inaczej pusta tablica. */
  variants: PriceVariant[];
  /** Grupa wyboru w ZESTAWIE (menu dnia): „1. danie"/„2. danie"/„deser". null = poza zestawem. */
  course: string | null;
  /** Dopłata przy wyborze tego dania w zestawie (np. „+2 €"). null = bez dopłaty. */
  surcharge: string | null;
}
/** Ograniczenie czasowe sekcji (menu dnia/lunch/weekend/sezon): krótki tekst, np. „pn-pt 13-16". null=brak. */
export interface StructSection { name: string; name_translated: string; items: StructItem[]; availability: string | null }
export interface MenuStructure {
  restaurant_name: string | null;
  restaurant_address: string | null;
  restaurant_language: string;
  cuisine: string;
  sections: StructSection[];
  notes: StructNote[];
  /** Czy ze zdjęć dało się cokolwiek odczytać. false = za słaba jakość (rozmazane/ciemne/ucięte). */
  readable: boolean;
  /** true = jakość słaba (np. czytelne działy, ale pozycje za małe/rozmyte) — wynik może być NIEPEŁNY. */
  low_quality: boolean;
  /** Wskazany lokal z listy „W POBLIŻU" (gdy była w prompcie), lub null. `index` = pozycja na liście. */
  venue_match?: { index: number; by: "name" | "cuisine" } | null;
}

export const STRUCTURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    restaurant_name: { type: ["string", "null"], description: "Nazwa lokalu. Najpierw szukaj wprost (okładka/nagłówek/stopka/szyld), w tym KRÓTKI TYTUŁ u góry karty/tablicy NAD listą dań — to nazwa lokalu, NAWET gdy stoi tuż przy logo sponsora-napoju (piwo: Estrella Damm/Mahou/San Miguel/Heineken; Coca-Cola) i NAWET gdy zawiera słowo kuchni (np. odręczne 'Tapas 23', 'Pizzeria Roma', 'Sushi Bar', 'Casa Pepe', 'Grill 22'); NIE spychaj takiego tytułu do notes. Samo graficzne LOGO marki napoju (Estrella, Mahou, Coca-Cola) to sponsoring, NIE nazwa. Jeśli nazwy NIE wypisano wprost, WYPROWADŹ ją z domeny/adresu www/e-maila/uchwytu social widocznego na karcie (np. 'www.centrum.indiantaste.com.pl' → 'Indian Taste'): odetnij TLD (.com/.pl/...) i człony generyczne (www, centrum, restauracja, menu, sklep, order, online), rozbij sklejone słowa na naturalną nazwę. NIE wyprowadzaj z platform dostaw/agregatorów ani social (pyszne, ubereats, glovo, wolt, bolt, deliveroo, tripadvisor, facebook, instagram, google) — to nie nazwa lokalu. null TYLKO gdy NIE MA żadnego sygnału nazwy — ani jawnego, ani w domenie/kontakcie lokalu." },
    restaurant_address: { type: ["string", "null"], description: "Adres lokalu, jeśli widoczny. Inaczej null." },
    restaurant_language: { type: "string", description: "Język menu jako kod ISO 639-1, np. 'it', 'es', 'pl'." },
    cuisine: { type: "string", description: "Rodzaj kuchni z menu (np. 'kuchnia indyjska'). Gdy nieoczywiste — 'nieokreślona'." },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Oryginalna nazwa sekcji (jak na menu)." },
          name_translated: { type: "string", description: "Nazwa sekcji przetłumaczona na język docelowy." },
          availability: { type: ["string", "null"], description: "Ograniczenie czasowe TEJ sekcji/menu (menu dnia tylko w tygodniu, brunch weekendowy, dania sezonowe/świąteczne itp.) — KRÓTKO, np. 'pn-pt 13-16', 'weekend', 'sezonowo'. Brak ograniczenia → null." },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                original: { type: "string", description: "Nazwa dania DOKŁADNIE jak na menu (oryginał)." },
                translated: { type: "string", description: "Nazwa dania przetłumaczona na język docelowy (jeśli sama nazwa jest niepełna bez grupy — przetłumacz kompletny sens, np. 'z mlekiem' pod 'Kawa' → 'coffee with milk' w języku docelowym)." },
                full_name: { type: "string", description: "KANONICZNA, ANGIELSKA, KOMPLETNA nazwa dania — UZUPEŁNIONA o kontekst grupy/sekcji, samodzielna i rozpoznawalna (np. grupa 'Kawa' + 'z mlekiem' → 'coffee with milk'; 'Lassi' + 'Mango' → 'mango lassi'; 'Arroz con pollo' → 'arroz con pollo'). To tożsamość dania do wzbogacania i wyszukiwania zdjęć — NIE markowa/lokalna skrótowa nazwa. BEZ rozmiaru/ilości/porcji ('1 litr', '250 ml', '0,5 l', 'duża') — te to warianty, idą do full_description/variants; ten sam napój w różnych rozmiarach = ta sama full_name. Gdy nazwa już pełna — po prostu jej angielski kanon." },
                full_description: { type: "string", description: "KANONICZNY, ANGIELSKI dodatkowy opis = TYLKO ISTOTNE wyróżniki tego dania, których nie widać po samej nazwie (nietypowy skład, sposób podania, wariant smaku), gdy karta je podaje i SĄ WAŻNE. Krótko, znormalizowanymi pojęciami (np. 'with bacon, fried egg, cheddar'). BEZ rozmiaru/gramatury (ten do `portion`). Gdy nazwa wystarcza — PUSTY string ''." },
                portion: { type: "string", description: "Gramatura/pojemność/ilość porcji DOKŁADNIE z karty: '250 ml', '200 g', '1 litr', '6 szt.', '33 cl'. Przepisz jak na karcie (z jednostką). Gdy karta nie podaje rozmiaru — PUSTY string ''. To NIE wariant cenowy (te idą do variants)." },
                menu_description: { type: "string", description: "Opis NADRUKOWANY na menu pod/obok dania (transkrypcja, oryginał). Gdy brak — pusty string." },
                menu_description_translated: { type: "string", description: "Wierne tłumaczenie opisu nadrukowanego na karcie na język docelowy. Gdy pozycja nie miała opisu z karty — pusty string." },
                source_text: { type: "string", description: "Przepisany FRAGMENT karty dla tej pozycji: pełna linijka/blok jak na menu (nazwa + ew. opis + cena), słowo w słowo — do pokazania skąd pochodzi pozycja." },
                price: { type: ["string", "null"], description: "Cena jako tekst, lub null gdy nie widać (LUB gdy są warianty — wtedy ceny idą do `variants`, a tu null)." },
                currency: { type: ["string", "null"], description: "Waluta, np. 'EUR', lub null." },
                variants: { type: "array", description: "Warianty cenowe, gdy pozycja ma KILKA cen (rozmiary/opcje: mała/duża, kieliszek/butelka, 0,3/0,5 l). Wtedy `price`=null. Inaczej pusta tablica.", items: { type: "object", additionalProperties: false, properties: { label: { type: "string", description: "Etykieta wariantu jak na menu (np. 'mała', 'duża', '0,5 l')." }, price: { type: "string", description: "Cena tego wariantu jako tekst." } }, required: ["label", "price"] } },
                course: { type: ["string", "null"], description: "Gdy pozycja to WYBÓR w ZESTAWIE (menu dnia) — KRÓTKA etykieta grupy wyboru: '1. danie', '2. danie', 'deser'. Poza zestawem → null." },
                surcharge: { type: ["string", "null"], description: "Dopłata przy wyborze tego dania w zestawie (np. '+2 €'). Brak dopłaty → null." },
              },
              required: ["original", "translated", "full_name", "full_description", "portion", "menu_description", "menu_description_translated", "source_text", "price", "currency", "variants", "course", "surcharge"],
            },
          },
        },
        required: ["name", "name_translated", "availability", "items"],
      },
    },
    notes: { type: "array", description: NOTES_SCHEMA_DESC, items: NOTE_SCHEMA_ITEM },
    readable: { type: "boolean", description: "Czy zdjęcia są dość czytelne, by odczytać menu. false = za słaba jakość (rozmazane, za ciemne, prześwietlone, ucięte) i nie da się sensownie nic transkrybować — wtedy zostaw sections puste." },
    low_quality: { type: "boolean", description: "true = jakość SŁABA: dało się odczytać część (np. nazwy działów/sekcji), ale pozycje są za małe/rozmyte/ucięte i wynik może być NIEPEŁNY albo niepewny. Mimo to wypisz wszystko, co dało się odczytać. false = zdjęcie wyraźne, odczyt pełny." },
    venue_match: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        index: { type: "integer", description: "Indeks (0-based) lokalu z listy W POBLIŻU (jeśli była podana), który pasuje do TEGO menu." },
        by: { type: "string", enum: ["name", "cuisine"], description: "name = dopasowano po NAZWIE widocznej na karcie; cuisine = po KUCHNI/stylu (gdy nazwy nie widać)." },
      },
      required: ["index", "by"],
      description: "Gdy w prompcie była lista W POBLIŻU: wskaż lokal pasujący do tego menu. NAJPIERW po nazwie widocznej na karcie (by=name). Jeśli nazwy NIE widać, możesz dopasować po kuchni (by=cuisine) ale TYLKO gdy jednoznaczne (jeden taki w okolicy). Brak listy / brak pewnego dopasowania → null.",
    },
  },
  required: ["restaurant_name", "restaurant_address", "restaurant_language", "cuisine", "sections", "notes", "readable", "low_quality", "venue_match"],
} as const;

// Przebieg 2 (TEKST, wsadowo). PO RE-ARCHITEKTURZE enrich generuje WYŁĄCZNIE GENERYCZNĄ wiedzę o daniu,
// której NIE było na karcie (opis „czym jest danie", składniki, alergeny, kategoria, dieta, ostrość,
// nazwa lokalna do zdjęć, branded). Tłumaczenia (nazwa, opis z karty, sekcje, notatki) robi już SKAN.
// Wejście identyfikuje pozycję przez `full_name` (kanoniczny EN) → enrich kluczowany po nim (max reużycie
// cross-menu). `index` = numer pozycji z LISTY PODANEJ W PROMPCIE (gęste 0..N-1).
export const ENRICH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer", description: "Numer pozycji z listy POZYCJE podanej w prompcie (ten sam numer w [..])." },
          photo_query: { type: "string", description: "NAJLEPSZY termin do wyszukania REPREZENTATYWNEGO zdjęcia tego dania (po angielsku, zromanizowany). Dość konkretny, by trafić TO danie, ale BEZ nadmiernego zawężania: NIE wstawiaj rozmiarów/ilości ('1 litr', '250 ml') ani długich list składników. Dla NAPOJÓW dodaj FORMĘ, gdy poprawia trafienie ('bottle', 'glass', 'can') — butelka wygląda inaczej niż szklanka. Celuj w gotową, podaną porcję." },
          photo_query_local: { type: "string", description: "Nazwa dania do zdjęć W JĘZYKU KRAJU lokalu (z lokalizacji) — jak ludzie szukają tego dania w tym kraju. Gdy się nie da — powtórz photo_query." },
          branded: { type: "boolean", description: "true = markowy/paczkowany produkt o stałym wyglądzie (Coca-Cola, butelkowana woda) → lepszy generyczny shot; false = potrawa z kuchni." },
          description: { type: "string", description: "Zwięzłe (1 zdanie, max 2), RZECZOWE wyjaśnienie CZYM JEST danie: typowe składniki, podanie, kontekst kulinarny — pasujące do TEJ kuchni i regionu. Wiedza GENERYCZNA o typie dania (nie cytuj opisu z karty). Nie upiększaj, nie dodawaj nietypowych składników." },
          ingredients: { type: "array", items: { type: "string" }, description: "Tylko składniki pewne/typowe (przetłumaczone na język docelowy)." },
          allergens: { type: "array", items: { type: "string" }, description: "Prawdopodobne alergeny — zachowawczo." },
          category: { type: "string", enum: [...DISH_CATEGORIES] },
          dietary: {
            type: "object",
            additionalProperties: false,
            properties: { vegetarian: { type: "boolean" }, vegan: { type: "boolean" }, gluten_free: { type: "boolean" } },
            required: ["vegetarian", "vegan", "gluten_free"],
          },
          spice_level: { type: "integer", enum: [0, 1, 2, 3] },
        },
        required: ["index", "photo_query", "photo_query_local", "branded", "description", "ingredients", "allergens", "category", "dietary", "spice_level"],
      },
    },
  },
  required: ["items"],
} as const;

export const MENU_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    restaurant_name: {
      type: ["string", "null"],
      description:
        "Nazwa restauracji, jeśli widoczna na którymkolwiek zdjęciu (np. okładka, nagłówek, stopka). Jeśli nie ma — null.",
    },
    restaurant_address: {
      type: ["string", "null"],
      description: "Adres lokalu, jeśli widoczny na menu. Jeśli nie ma — null.",
    },
    restaurant_language: {
      type: "string",
      description: "Wykryty język menu jako kod ISO 639-1, np. 'it', 'fr', 'pl'.",
    },
    cuisine: {
      type: "string",
      description:
        "Rodzaj kuchni ustalony z menu (np. 'kuchnia indyjska', 'kuchnia hiszpańska', 'włoska'). Gdy nieoczywiste — 'nieokreślona'.",
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Oryginalna nazwa sekcji." },
          name_translated: { type: "string", description: "Nazwa sekcji po przetłumaczeniu." },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                original: { type: "string", description: "Nazwa dania w oryginale." },
                translated: { type: "string", description: "Nazwa dania po przetłumaczeniu." },
                menu_description: { type: "string", description: "Opis NADRUKOWANY na karcie (transkrypcja), gdy był; inaczej pusty string." },
                menu_description_translated: { type: "string", description: "Wierne tłumaczenie opisu z karty (gdy był); inaczej pusty string." },
                photo_query: {
                  type: "string",
                  description:
                    "KANONICZNA nazwa dania do wyszukiwania zdjęć — najlepiej rozpoznawalna nazwa potrawy w jej własnej kuchni (zromanizowana), z dopisanym typem/kuchnią dla jednoznaczności. Opisz CZYM danie jest, NIE markową/lokalną nazwą z menu. Przykłady: 'Mango' (curry) → 'mango chicken curry indian'; 'Nordic Taste' → 'smoked salmon avocado toast'; 'Patates Braves' → 'patatas bravas'; danie tajskie → 'pad thai noodles'. Dla zwykłych nazw — ta nazwa po angielsku + typ.",
                },
                photo_query_local: {
                  type: "string",
                  description:
                    "Nazwa dania do wyszukiwania zdjęć W JĘZYKU KRAJU, w którym jest lokal (kraj wynika z podanej lokalizacji) — tak, jak ludzie szukają tego dania w tym kraju. Gdy język menu = język kraju, zwykle = original. Gdy menu jest w innym języku (np. po angielsku, a lokal w Polsce), podaj nazwę w języku kraju (np. 'kurczak maślany'). Gdy nie da się sensownie podać — powtórz photo_query.",
                },
                branded: {
                  type: "boolean",
                  description:
                    "true = markowy/paczkowany produkt o znanym wyglądzie (np. Coca-Cola, Sprite, Fanta, butelkowana woda, batonik), dla którego najlepsze jest GENERYCZNE zdjęcie produktu, a NIE zdjęcie z lokalu. false = potrawa/danie przyrządzane (kuchnia), gdzie warto szukać zdjęcia z tego lokalu.",
                },
                description: {
                  type: "string",
                  description:
                    "Zwięzłe wyjaśnienie czym jest danie: typowe składniki, sposób podania, kontekst kulinarny.",
                },
                ingredients: {
                  type: "array",
                  items: { type: "string" },
                  description: "Typowe składniki dania (przetłumaczone).",
                },
                allergens: {
                  type: "array",
                  items: { type: "string" },
                  description: "Prawdopodobne alergeny (gluten, orzechy, ryby, jaja, laktoza itd.).",
                },
                category: { type: "string", enum: [...DISH_CATEGORIES] },
                dietary: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    vegetarian: { type: "boolean" },
                    vegan: { type: "boolean" },
                    gluten_free: { type: "boolean" },
                  },
                  required: ["vegetarian", "vegan", "gluten_free"],
                },
                spice_level: {
                  type: "integer",
                  enum: [0, 1, 2, 3],
                  description: "Poziom ostrości: 0 = brak, 3 = bardzo ostre.",
                },
                price: { type: ["string", "null"], description: "Cena jako tekst, lub null." },
                currency: { type: ["string", "null"], description: "Waluta, np. 'EUR', lub null." },
              },
              required: [
                "original",
                "translated",
                "menu_description",
                "menu_description_translated",
                "photo_query",
                "photo_query_local",
                "branded",
                "description",
                "ingredients",
                "allergens",
                "category",
                "dietary",
                "spice_level",
                "price",
                "currency",
              ],
            },
          },
        },
        required: ["name", "name_translated", "items"],
      },
    },
    notes: {
      type: "array",
      description: NOTES_SCHEMA_DESC,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Treść adnotacji w oryginale." },
          text_translated: { type: "string", description: "Treść adnotacji po przetłumaczeniu." },
          scope: { type: "string", enum: ["menu", "section"] },
          section_index: { type: ["integer", "null"], description: "Indeks sekcji (od 0) gdy scope='section', inaczej null." },
          kind: { type: "string", enum: [...NOTE_KINDS] },
        },
        required: ["text", "text_translated", "scope", "section_index", "kind"],
      },
    },
  },
  required: [
    "restaurant_name",
    "restaurant_address",
    "restaurant_language",
    "cuisine",
    "sections",
    "notes",
  ],
} as const;

// ===== EKSPERYMENT: SKAN JEDNOFAZOWY (struktura + enrich w JEDNYM wywołaniu vision) ===========
// Pełny Menu od razu z obrazu: struktura + tłumaczenia + opisy + photo_query — to, co dziś robi
// osobny enrich. Schemat = MENU_SCHEMA UZUPEŁNIONY o nowsze pola (source_text/variants/course/
// surcharge na pozycji, availability sekcji, readable/low_quality/venue_match menu), żeby jednofazowy
// dał TEN SAM kształt co dwufazowy — do uczciwego porównania jakości/kosztu w LABie.
export const ONEPASS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    restaurant_name: { type: ["string", "null"], description: "Nazwa lokalu. Najpierw szukaj wprost (okładka/nagłówek/stopka/szyld), w tym KRÓTKI TYTUŁ u góry karty/tablicy NAD listą dań — to nazwa lokalu, NAWET gdy stoi tuż przy logo sponsora-napoju (piwo: Estrella Damm/Mahou/San Miguel/Heineken; Coca-Cola) i NAWET gdy zawiera słowo kuchni (np. odręczne 'Tapas 23', 'Pizzeria Roma', 'Sushi Bar', 'Casa Pepe', 'Grill 22'); NIE spychaj takiego tytułu do notes. Samo graficzne LOGO marki napoju (Estrella, Mahou, Coca-Cola) to sponsoring, NIE nazwa. Jeśli nazwy NIE wypisano wprost, WYPROWADŹ ją z domeny/adresu www/e-maila/uchwytu social widocznego na karcie (np. 'www.centrum.indiantaste.com.pl' → 'Indian Taste'): odetnij TLD (.com/.pl/...) i człony generyczne (www, centrum, restauracja, menu, sklep, order, online), rozbij sklejone słowa na naturalną nazwę. NIE wyprowadzaj z platform dostaw/agregatorów ani social (pyszne, ubereats, glovo, wolt, bolt, deliveroo, tripadvisor, facebook, instagram, google) — to nie nazwa lokalu. null TYLKO gdy NIE MA żadnego sygnału nazwy — ani jawnego, ani w domenie/kontakcie lokalu." },
    restaurant_address: { type: ["string", "null"], description: "Adres lokalu, jeśli widoczny. Inaczej null." },
    restaurant_language: { type: "string", description: "Język menu jako kod ISO 639-1, np. 'it', 'es', 'pl'." },
    cuisine: { type: "string", description: "Rodzaj kuchni — KRÓTKI, KANONICZNY termin PO ANGIELSKU, małymi literami (np. 'spanish'/'fusion'/'sushi'). Gdy nieoczywiste — 'unknown'." },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Oryginalna nazwa sekcji (jak na menu)." },
          name_translated: { type: "string", description: "Nazwa sekcji po przetłumaczeniu na język docelowy." },
          availability: { type: ["string", "null"], description: "Ograniczenie czasowe TEJ sekcji (menu dnia w tygodniu, brunch weekendowy, sezonowo) — KRÓTKO ('pn-pt 13-16', 'weekend'). Brak → null." },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                original: { type: "string", description: "Nazwa dania DOKŁADNIE jak na menu (oryginał)." },
                translated: { type: "string", description: "Nazwa dania po przetłumaczeniu na język docelowy." },
                full_name: { type: "string", description: "KANONICZNA, ANGIELSKA, KOMPLETNA nazwa (z kontekstem grupy) — tożsamość do wzbogacania i zdjęć (np. 'Kawa'+'z mlekiem' → 'coffee with milk', 'Lassi'+'Mango' → 'mango lassi'). Gdy nazwa już pełna — jej angielski kanon." },
                full_description: { type: "string", description: "KANONICZNY ANGIELSKI dodatkowy opis = TYLKO istotne wyróżniki (nietypowy skład/podanie), gdy ważne; BEZ rozmiaru (ten do portion); inaczej PUSTY ''." },
                portion: { type: "string", description: "Gramatura/pojemność/ilość z karty ('250 ml', '200 g', '1 litr'); '' gdy brak. To nie wariant cenowy." },
                source_text: { type: "string", description: "Przepisany FRAGMENT karty dla tej pozycji (nazwa + ew. opis + cena), słowo w słowo — skąd pochodzi." },
                menu_description: { type: "string", description: "Opis NADRUKOWANY na karcie (transkrypcja), gdy był; inaczej pusty string." },
                menu_description_translated: { type: "string", description: "Wierne tłumaczenie opisu z karty (gdy był); inaczej pusty string." },
                photo_query: { type: "string", description: "KANONICZNA, ROZPOZNAWALNA nazwa potrawy do zdjęć (zromanizowana) — MINIMUM słów (2-3), jak ludzie wyszukują (np. 'patatas bravas', 'mango chicken curry', 'caesar salad'). Opisz CZYM danie jest, NIE markową/lokalną nazwą; nie rozwlekaj składnikami ani narodowością." },
                photo_query_local: { type: "string", description: "Nazwa do zdjęć W JĘZYKU KRAJU lokalu (z lokalizacji). Gdy język menu = język kraju, zwykle = original; gdy się nie da — powtórz photo_query." },
                branded: { type: "boolean", description: "true = markowy/paczkowany produkt o stałym wyglądzie (Coca-Cola, butelkowana woda) → generyczny shot; false = potrawa z kuchni." },
                description: { type: "string", description: "ZWIĘŹLE (1 zdanie, max 2), RZECZOWO czym jest danie: składniki/podanie/kontekst pasujące do TEJ kuchni i regionu. Gdy jest opis z karty — OPRZYJ się na nim. Nie upiększaj, nie dodawaj nietypowych składników." },
                ingredients: { type: "array", items: { type: "string" }, description: "Tylko składniki pewne/typowe (przetłumaczone)." },
                allergens: { type: "array", items: { type: "string" }, description: "Prawdopodobne alergeny — zachowawczo." },
                category: { type: "string", enum: [...DISH_CATEGORIES] },
                dietary: { type: "object", additionalProperties: false, properties: { vegetarian: { type: "boolean" }, vegan: { type: "boolean" }, gluten_free: { type: "boolean" } }, required: ["vegetarian", "vegan", "gluten_free"] },
                spice_level: { type: "integer", enum: [0, 1, 2, 3], description: "0 = brak, 3 = bardzo ostre." },
                price: { type: ["string", "null"], description: "Cena jako tekst, lub null (LUB gdy są warianty — wtedy ceny w `variants`, a tu null)." },
                currency: { type: ["string", "null"], description: "Waluta, np. 'EUR', lub null." },
                variants: { type: "array", description: "Warianty cenowe gdy KILKA cen (mała/duża, kieliszek/butelka). Wtedy `price`=null. Inaczej pusta tablica.", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, price: { type: "string" } }, required: ["label", "price"] } },
                course: { type: ["string", "null"], description: "Gdy pozycja to WYBÓR w ZESTAWIE (menu dnia) — KRÓTKA etykieta grupy: '1. danie'/'2. danie'/'deser'. Poza zestawem → null." },
                surcharge: { type: ["string", "null"], description: "Dopłata przy wyborze w zestawie (np. '+2 €'). Brak → null." },
              },
              required: ["original", "translated", "full_name", "full_description", "portion", "source_text", "menu_description", "menu_description_translated", "photo_query", "photo_query_local", "branded", "description", "ingredients", "allergens", "category", "dietary", "spice_level", "price", "currency", "variants", "course", "surcharge"],
            },
          },
        },
        required: ["name", "name_translated", "availability", "items"],
      },
    },
    notes: {
      type: "array",
      description: NOTES_SCHEMA_DESC,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Treść adnotacji DOKŁADNIE jak na menu (oryginał)." },
          text_translated: { type: "string", description: "Treść adnotacji po przetłumaczeniu." },
          scope: { type: "string", enum: ["menu", "section"] },
          section_index: { type: ["integer", "null"], description: "Indeks sekcji (od 0) gdy scope='section', inaczej null." },
          kind: { type: "string", enum: [...NOTE_KINDS] },
        },
        required: ["text", "text_translated", "scope", "section_index", "kind"],
      },
    },
    readable: { type: "boolean", description: "Czy zdjęcia dość czytelne, by odczytać menu. false = za słaba jakość i nic nie da się odczytać (wtedy sections puste)." },
    low_quality: { type: "boolean", description: "true = jakość SŁABA, dało się odczytać tylko część (wynik może być niepełny). false = odczyt pełny." },
    venue_match: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: { index: { type: "integer" }, by: { type: "string", enum: ["name", "cuisine"] } },
      required: ["index", "by"],
      description: "Gdy w prompcie była lista W POBLIŻU: wskaż pasujący lokal (NAJPIERW po nazwie z karty by='name'; po kuchni by='cuisine' tylko gdy jednoznaczne). Brak → null.",
    },
  },
  required: ["restaurant_name", "restaurant_address", "restaurant_language", "cuisine", "sections", "notes", "readable", "low_quality", "venue_match"],
} as const;
