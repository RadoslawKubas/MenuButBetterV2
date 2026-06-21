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
  /** Zakres: całe menu albo konkretna sekcja. */
  scope: "menu" | "section";
  /** Indeks sekcji (gdy scope="section"), inaczej null. */
  section_index: number | null;
  /** Typ do prezentacji: wait/fee/tax/tip/hours/info. */
  kind: NoteKind;
}
export interface MenuNote extends StructNote {
  /** Treść po przetłumaczeniu (uzupełniana w enrich). */
  text_translated: string;
}

// Wspólny fragment schematu adnotacji (dla STRUCTURE i MENU single-pass).
const NOTE_SCHEMA_ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", description: "Treść adnotacji DOKŁADNIE jak na menu (oryginał)." },
    scope: { type: "string", enum: ["menu", "section"], description: "'menu' = dotyczy całego menu; 'section' = dotyczy KONKRETNEJ sekcji." },
    section_index: { type: ["integer", "null"], description: "Indeks sekcji (kolejność w 'sections', licząc od 0), gdy scope='section'. Inaczej null." },
    kind: { type: "string", enum: [...NOTE_KINDS], description: "Typ: set=ZESTAW/menu dnia (cena zestawu + co wliczone + co do wyboru), included=co dochodzi/jest wliczone do dań tej grupy (np. 'do każdego dania sałatka', 'w cenie pieczywo'), wait=czas oczekiwania, fee=dopłata/serwis/cover/taras, tax=VAT/podatek, tip=napiwek, hours=godziny, info=inne (np. 'ryż min. dla 2 osób', minimalne zamówienie, alergeny)." },
  },
  required: ["text", "scope", "section_index", "kind"],
} as const;
const NOTES_SCHEMA_DESC = "Adnotacje menu, które NIE są daniami: ZESTAWY/menu dnia (cena + skład + do wyboru), to co WLICZONE/dochodzi do dań danej grupy ('do każdego dania sałatka', 'w cenie pieczywo'), info o porcjach ('ryż min. dla 2 osób'), czas oczekiwania, dopłaty (taras/serwis/cover), VAT/podatek, napiwek, godziny, minimalne zamówienie, ogólne uwagi o alergenach. Gdy dotyczą KONKRETNEJ grupy/sekcji — ustaw scope='section' + section_index, żeby pokazać je pod nazwą tej grupy. NIE umieszczaj ich jako pozycje (dania). Gdy brak — pusta tablica.";

export interface MenuItem {
  original: string;
  translated: string;
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
  original: string;
  /** Opis WIDOCZNY na menu (transkrypcja), jeśli jest — inaczej "". Generowany opis robi enrich. */
  menu_description: string;
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
export interface StructSection { name: string; items: StructItem[]; availability: string | null }
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
    restaurant_name: { type: ["string", "null"], description: "Nazwa lokalu, jeśli widoczna (okładka/nagłówek/stopka/szyld). Inaczej null." },
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
          availability: { type: ["string", "null"], description: "Ograniczenie czasowe TEJ sekcji/menu (menu dnia tylko w tygodniu, brunch weekendowy, dania sezonowe/świąteczne itp.) — KRÓTKO, np. 'pn-pt 13-16', 'weekend', 'sezonowo'. Brak ograniczenia → null." },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                original: { type: "string", description: "Nazwa dania DOKŁADNIE jak na menu (oryginał)." },
                menu_description: { type: "string", description: "Opis NADRUKOWANY na menu pod/obok dania (transkrypcja). Gdy brak — pusty string." },
                source_text: { type: "string", description: "Przepisany FRAGMENT karty dla tej pozycji: pełna linijka/blok jak na menu (nazwa + ew. opis + cena), słowo w słowo — do pokazania skąd pochodzi pozycja." },
                price: { type: ["string", "null"], description: "Cena jako tekst, lub null gdy nie widać (LUB gdy są warianty — wtedy ceny idą do `variants`, a tu null)." },
                currency: { type: ["string", "null"], description: "Waluta, np. 'EUR', lub null." },
                variants: { type: "array", description: "Warianty cenowe, gdy pozycja ma KILKA cen (rozmiary/opcje: mała/duża, kieliszek/butelka, 0,3/0,5 l). Wtedy `price`=null. Inaczej pusta tablica.", items: { type: "object", additionalProperties: false, properties: { label: { type: "string", description: "Etykieta wariantu jak na menu (np. 'mała', 'duża', '0,5 l')." }, price: { type: "string", description: "Cena tego wariantu jako tekst." } }, required: ["label", "price"] } },
                course: { type: ["string", "null"], description: "Gdy pozycja to WYBÓR w ZESTAWIE (menu dnia) — KRÓTKA etykieta grupy wyboru: '1. danie', '2. danie', 'deser'. Poza zestawem → null." },
                surcharge: { type: ["string", "null"], description: "Dopłata przy wyborze tego dania w zestawie (np. '+2 €'). Brak dopłaty → null." },
              },
              required: ["original", "menu_description", "source_text", "price", "currency", "variants", "course", "surcharge"],
            },
          },
        },
        required: ["name", "availability", "items"],
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

// Przebieg 2 (TEKST, wsadowo po nazwach): wzbogaca pozycje o pola, które NIE wymagają obrazu —
// tłumaczenie, photo_query/_local, branded, generowany opis, składniki, alergeny, kategoria, dieta,
// ostrość — z kontekstu (kuchnia/kraj/język). Tanie, cache'owalne per pozycja. `index` = numer pozycji
// z LISTY PODANEJ W PROMPCIE (te same numery, gęste 0..N-1), tak samo `sections[].index`/`notes[].index`.
export const ENRICH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { index: { type: "integer" }, name_translated: { type: "string" } },
        required: ["index", "name_translated"],
      },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "integer", description: "Numer pozycji z listy POZYCJE podanej w prompcie (ten sam numer w [..])." },
          translated: { type: "string" },
          photo_query: { type: "string", description: "KANONICZNA nazwa potrawy do zdjęć (zromanizowana) + typ/kuchnia dla jednoznaczności; opisz CZYM danie jest, nie markową/lokalną nazwą. Np. 'Mango'→'mango chicken curry indian'." },
          photo_query_local: { type: "string", description: "Nazwa do zdjęć W JĘZYKU KRAJU lokalu (z lokalizacji). Gdy język menu = język kraju, zwykle = original; gdy się nie da — powtórz photo_query." },
          branded: { type: "boolean", description: "true = markowy/paczkowany produkt o stałym wyglądzie (Coca-Cola, butelkowana woda) → lepszy generyczny shot; false = potrawa z kuchni." },
          menu_description_translated: { type: "string", description: "Wierne TŁUMACZENIE opisu nadrukowanego na karcie (część po '|' w wejściu), gdy taki opis był. Tłumacz dokładnie, nie dodawaj nic od siebie. Gdy pozycja nie miała opisu z karty — pusty string." },
          description: { type: "string", description: "Zwięzłe wyjaśnienie czym jest danie: składniki, podanie, kontekst kulinarny — pasujące do TEJ kuchni i regionu. Gdy jest opis z karty, OPRZYJ się GŁÓWNIE na nim." },
          ingredients: { type: "array", items: { type: "string" } },
          allergens: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: [...DISH_CATEGORIES] },
          dietary: {
            type: "object",
            additionalProperties: false,
            properties: { vegetarian: { type: "boolean" }, vegan: { type: "boolean" }, gluten_free: { type: "boolean" } },
            required: ["vegetarian", "vegan", "gluten_free"],
          },
          spice_level: { type: "integer", enum: [0, 1, 2, 3] },
        },
        required: ["index", "translated", "photo_query", "photo_query_local", "branded", "menu_description_translated", "description", "ingredients", "allergens", "category", "dietary", "spice_level"],
      },
    },
    notes: {
      type: "array",
      description: "Tłumaczenia adnotacji menu (index = pozycja w tablicy notes z wejścia).",
      items: { type: "object", additionalProperties: false, properties: { index: { type: "integer" }, text_translated: { type: "string" } }, required: ["index", "text_translated"] },
    },
  },
  required: ["sections", "items", "notes"],
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
