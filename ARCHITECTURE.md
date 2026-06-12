# MenuButBetter — Architektura i plan

> Aplikacja mobilna (iOS + Android): robisz zdjęcie menu w restauracji, a aplikacja
> tłumaczy je, wyjaśnia czym są poszczególne potrawy, dodaje zdjęcia dań i kontekst
> (lokalizacja, oceny). „Menu, ale lepsze."

Status: **dokument planistyczny** (kod jeszcze nie istnieje).
Data: 2026-06-07. Autor decyzji produktowych: rk@appwithkiss.com.

---

## 1. Wizja produktu i przepływ użytkownika

```
[Aparat] → zdjęcie menu
   │
   ▼
[Backend] ── wywołanie Claude (vision) ──► strukturyzowane menu (JSON)
   │                                         • pozycje + tłumaczenie
   │                                         • opis dania, składniki, alergeny
   │                                         • kategoria, poziom ostrości, wege/wega
   │
   ├── (równolegle) GPS → Google Places → identyfikacja restauracji
   │                                         • nazwa, adres, ocena, zdjęcia lokalu
   │
   └── (na żądanie / leniwie) zdjęcia dań ze źródeł zewnętrznych
          │
          ▼
[Aplikacja] renderuje przetłumaczone menu z opisami, zdjęciami i filtrowaniem
```

**Kluczowa decyzja architektoniczna:** zamiast klasycznego pipeline'u
`OCR → tłumaczenie → opis`, używamy **jednego wywołania multimodalnego LLM (Claude
vision)**, które z samego zdjęcia zwraca gotowy, ustrukturyzowany JSON. To radzi sobie
z odręcznym pismem, slangiem kulinarnym, regionalnymi nazwami i układem menu znacznie
lepiej niż klasyczne OCR + osobny tłumacz, i upraszcza backend do jednej integracji.

---

## 2. Stack technologiczny

| Warstwa | Wybór | Uzasadnienie |
|---|---|---|
| **Aplikacja mobilna** | **React Native + Expo** (TypeScript) | Jeden kod na iOS i Android, natywne uruchomienie, najlepsze wsparcie pod „vibe coding". EAS Build robi paczki do App Store i Google Play bez ręcznej konfiguracji Xcode/Android Studio. |
| Aparat / zdjęcia | `expo-camera`, `expo-image-picker` | Wbudowane, natywne. |
| Lokalizacja | `expo-location` | GPS z prośbą o uprawnienia. |
| Nawigacja | `expo-router` | Routing oparty na plikach. |
| Stan / dane | TanStack Query + Zustand | Cache zapytań sieciowych + lekki stan globalny. |
| **Backend** | **TypeScript serverless** (np. Cloudflare Workers / Vercel Functions) | Cienka warstwa pośrednicząca; ukrywa klucze API; ten sam język co frontend. |
| LLM | **Claude API** (`@anthropic-ai/sdk`) | OCR + tłumaczenie + opis dań w jednym wywołaniu vision + structured outputs. |
| Restauracja / lokal | **Google Places API** | Identyfikacja restauracji z GPS, zdjęcia lokalu, oceny. |
| Baza danych | Postgres (Supabase / Neon) | Użytkownicy, historia skanów, cache menu, ulubione. |
| Storage zdjęć | S3 / R2 / Supabase Storage | Zdjęcia menu i wygenerowane miniatury. |
| Auth | Supabase Auth / Clerk | Logowanie (opcjonalne na start — patrz MVP). |

> **Dlaczego nie MAUI?** Znasz MAUI, ale przy 100% vibe codingu liczy się pętla
> iteracji i ekosystem. React Native + Expo ma gotowe moduły kamery/lokalizacji,
> EAS do publikacji w obu sklepach, ogromny ekosystem i jest najlepiej wspierany przez
> narzędzia AI. MAUI publikuje się do sklepów boleśniej i ma znikomy ekosystem pod AI.

---

## 3. Rdzeń: wyciąganie menu z Claude vision

Backend wysyła zdjęcie menu do Claude i wymusza ustrukturyzowaną odpowiedź przez
**structured outputs** (`output_config.format` z JSON Schema). Dzięki temu odpowiedź
jest zawsze parsowalna — bez kruchego parsowania tekstu.

### Wybór modelu

Domyślnie najsilniejszy model to **Opus 4.8** (`claude-opus-4-8`). Ale dla aplikacji
konsumenckiej, gdzie liczy się koszt na skan i szybkość, **Sonnet 4.6**
(`claude-sonnet-4-6`) jest świetnym balansem przy zachowaniu wysokiej jakości vision.

| Model | ID | Wejście / Wyjście (za 1M tok.) | Szac. koszt / skan¹ | Rekomendacja |
|---|---|---|---|---|
| Opus 4.8 | `claude-opus-4-8` | $5 / $25 | ~$0,09 | Najwyższa jakość; trudne/odręczne menu |
| **Sonnet 4.6** | `claude-sonnet-4-6` | $3 / $15 | **~$0,05** | **Domyślny koń roboczy MVP** |
| Haiku 4.5 | `claude-haiku-4-5` | $1 / $5 | ~$0,02 | Najtaniej; proste, drukowane menu |

¹ Założenie: zdjęcie ~2,5k tokenów wejścia + ~3k tokenów ustrukturyzowanego JSON na
wyjściu. Rzeczywisty koszt zależy od rozmiaru menu. Realnie kilka centów za skan.

**Strategia:** start na Sonnet 4.6. Można dać fallback — jeśli wynik wygląda słabo
(mało pozycji, niska pewność), ponowić na Opus 4.8. Vision na Opus 4.7+ ma
wysokorozdzielczość (do 2576 px), co pomaga przy gęstych/odręcznych menu.

### Przykładowy schemat odpowiedzi (JSON Schema)

```jsonc
{
  "restaurant_language": "it",        // wykryty język menu
  "sections": [
    {
      "name": "Antipasti",            // oryginalna nazwa sekcji
      "name_translated": "Przystawki",
      "items": [
        {
          "original": "Vitello tonnato",
          "translated": "Cielęcina w sosie tuńczykowym",
          "description": "Cienko krojona pieczona cielęcina podawana na zimno z kremowym sosem z tuńczyka, kaparów i majonezu. Klasyk kuchni piemonckiej.",
          "ingredients": ["cielęcina", "tuńczyk", "kapary", "majonez", "anchois"],
          "allergens": ["ryby", "jaja"],
          "category": "starter",
          "dietary": { "vegetarian": false, "vegan": false, "gluten_free": true },
          "spice_level": 0,            // 0–3
          "price": "14",
          "currency": "EUR"
        }
      ]
    }
  ]
}
```

Pełny schemat trzyma się ograniczeń structured outputs (typy bazowe, `enum`,
`additionalProperties: false`; bez `minLength`/`maximum` itp.).

### Zarys wywołania (backend, TypeScript)

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic(); // klucz z ANTHROPIC_API_KEY (env, NIGDY w aplikacji)

const response = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 8000,
  system:
    "Jesteś ekspertem kulinarnym i tłumaczem. Z obrazu menu wyodrębnij wszystkie " +
    "pozycje. Tłumacz na język użytkownika. Zwięźle wyjaśniaj nieznane potrawy, " +
    "podawaj typowe składniki i alergeny. Nie wymyślaj pozycji, których nie ma na zdjęciu.",
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } },
      { type: "text", text: `Język docelowy: ${targetLang}. Lokal: ${restaurantHint ?? "nieznany"}.` },
    ],
  }],
  output_config: { format: { type: "json_schema", schema: MENU_SCHEMA } },
});
```

> Uwaga: dla dużych menu i `max_tokens` > ~16k używać streamingu (`client.messages.stream`).

---

## 4. Zdjęcia dań — dwa tryby (osobisty vs sklepowy)

Zdjęcia dań mają **dwa różne reżimy** i projektujemy je jako **wymienialny moduł**
(`DishPhotoProvider`), żeby zmiana źródła nie ruszała reszty aplikacji.

- **Tryb osobisty (build prywatny, dla siebie):** cel — w restauracji szybko znaleźć
  prawdziwe zdjęcie potrawy. Tu dozwolone jest wyszukiwanie obrazów. **Nie scrapujemy
  HTML** (kruche, blokady) — używamy oficjalnego **API wyszukiwania obrazów**, które
  zwraca URL-e. Stabilne i czyste.
- **Tryb sklepowy (publiczne wydanie):** podmieniamy dostawcę na zgodny z regulaminami
  (Places Photos / generacja AI / UGC). Scraping i masowe wyszukiwanie cudzych zdjęć
  nie nadają się do produktu w App Store / Google Play — ale to decyzja na później.

### Abstrakcja dostawcy

```ts
type DishPhoto = { url: string; źródło: string; atrybucja?: string };

interface DishPhotoProvider {
  // np. ("Vitello tonnato", "Trattoria Roma, Kraków") → kandydaci zdjęć
  find(dish: string, restaurantHint?: string): Promise<DishPhoto[]>;
}
```

Aplikacja woła zawsze `DishPhotoProvider.find(...)`; który provider jest aktywny,
decyduje config/build (`personal` vs `store`). Cache w tabeli `dish_photos`.

### Dostawcy

| Provider | Tryb | Jak działa | Uwagi |
|---|---|---|---|
| **Google Custom Search JSON API** (image) | osobisty | Oficjalne API Google do wyszukiwania obrazów. Zapytanie „danie + restauracja/miasto", `searchType=image` → URL-e zdjęć | **Rekomendowane do trybu osobistego.** Darmowe ~100 zapytań/dzień, potem płatne. Legalny, stabilny endpoint zamiast scrapingu |
| **SerpAPI** (lub podobne) | osobisty | Płatny pośrednik zwracający wyniki Google Images jako JSON | Wygodne, ale płatne i zależne od warunków pośrednika |
| **Google Places Photos API** | sklepowy | Zdjęcia lokalu/dań z Google Maps | Legalne, licencjonowane; zdjęcia lokalu, nie zawsze konkretnego dania; wymaga atrybucji |
| **Generacja AI** | sklepowy | Poglądowe zdjęcie z opisu dania | Zawsze dostępne; oznaczyć „wizualizacja"; koszt generacji |
| **UGC (społeczność)** | sklepowy | Użytkownicy dodają zdjęcia | Realne dania; wymaga skali i moderacji |

### Jakość trafień (heurystyki)

Wyszukiwanie po samej nazwie potrawy bywa nietrafne. Poprawiamy trafność przez:
- doklejanie kontekstu z §5: nazwa restauracji + miasto (`"vitello tonnato" trattoria roma kraków`),
- fallback na samą nazwę dania + kuchnię, gdy brak wyników z lokalem,
- (opcjonalnie) re-ranking kandydatów przez Claude vision: „które z tych zdjęć
  najlepiej pasuje do opisu dania?" — odfiltrowuje przypadkowe trafienia,
- cache po sygnaturze `danie+lokal`, żeby nie odpytywać API wielokrotnie.

> **Klucz do Custom Search trzymamy na backendzie** (jak każdy inny). Aplikacja woła
> nasz endpoint `/dish-photos`, nie Google bezpośrednio.

---

## 5. Identyfikacja restauracji (lokalizacja)

1. Aplikacja pobiera GPS (`expo-location`).
2. Backend pyta **Google Places Nearby Search** → lista pobliskich restauracji.
3. Jeśli jedna dominuje (blisko + pasuje), przypisujemy automatycznie; w razie
   wątpliwości pokazujemy użytkownikowi listę do wyboru.
4. Z Places pobieramy: nazwę, adres, ocenę, godziny, zdjęcia lokalu — wzbogacamy widok.

---

## 6. Model danych (zarys)

```
users           (id, email, język_domyślny, utworzono)
scans           (id, user_id, restaurant_id?, zdjęcie_url, lang_źródłowy,
                 lang_docelowy, menu_json, utworzono)
restaurants     (id, google_place_id, nazwa, adres, lat, lng, ocena, cache_do)
favorites       (id, user_id, scan_id, item_index, notatka)
dish_photos     (id, item_signature, źródło, url, atrybucja)   -- cache zdjęć dań
```

`menu_json` przechowuje surowy wynik z Claude (patrz §3) — pozwala renderować bez
ponownego wywołania API. Cache menu po hashu zdjęcia ⇒ oszczędność kosztów LLM.

---

## 7. Bezpieczeństwo i koszty

- **Klucze API (Claude, Google) NIGDY w aplikacji mobilnej** — da się je wyciągnąć.
  Wszystkie wywołania idą przez backend.
- Rate limiting per użytkownik (ochrona przed nadużyciem kosztownego API).
- Cache: ten sam skan / to samo menu nie odpytuje LLM ponownie.
- Kompresja zdjęć przed wysyłką (mniej tokenów wejścia, szybciej, taniej).
- Szacunkowy koszt zmienny: ~kilka centów za skan (LLM) + koszty Places. Przy
  10k skanów/mies. ≈ $500–900 LLM + Places. Do uściślenia po pomiarach.

---

## 8. Roadmapa MVP

**Faza 0 — Fundament (PoC)**
- [ ] Skrypt backendowy: zdjęcie menu → Claude vision → ustrukturyzowany JSON.
- [ ] Walidacja jakości na 10–15 realnych zdjęć menu w różnych językach.

**Faza 1 — Aplikacja core (MVP)**
- [ ] Scaffold Expo (TypeScript, expo-router).
- [ ] Ekran aparatu → wysyłka zdjęcia do backendu.
- [ ] Backend serverless z proxy do Claude + structured outputs.
- [ ] Ekran wyniku: przetłumaczone menu z opisami, składnikami, alergenami.
- [ ] Wybór języka docelowego.

**Faza 2 — Kontekst**
- [ ] Lokalizacja + Google Places (identyfikacja restauracji, zdjęcia lokalu, ocena).
- [ ] Filtry: wege/wega, bez glutenu, poziom ostrości.
- [ ] Historia skanów + ulubione (wymaga auth + bazy).

**Faza 3 — Zdjęcia dań i polish**
- [ ] Zdjęcia dań (Google Places / generacja AI / UGC — patrz §4).
- [ ] Onboarding, ikona, ekrany sklepowe.
- [ ] Publikacja: TestFlight (iOS) + Internal testing (Google Play) → release.

---

## 9. Struktura repo (docelowa)

```
MenuButBetter/
├── ARCHITECTURE.md            ← ten plik
├── mobile/                    ← aplikacja Expo (React Native) ✅
│   ├── App.tsx               ← główny ekran (aparat → skan → wynik)
│   └── src/
│       ├── api.ts            ← klient backendu (auto-wykrycie IP dev-serwera)
│       ├── image.ts          ← aparat/galeria + kompresja
│       ├── MenuView.tsx      ← render przetłumaczonego menu
│       └── types.ts          ← typy menu
├── server/                    ← backend ✅
│   ├── src/
│   │   ├── http.ts           ← endpoint HTTP /scan (Hono)
│   │   ├── menu.ts           ← wywołanie Claude vision
│   │   ├── dishPhotos.ts     ← provider zdjęć dań (wymienialny)
│   │   ├── runScan.ts        ← runner CLI (PoC)
│   │   └── schema.ts         ← JSON Schema menu
│   └── samples/              ← lokalne zdjęcia testowe (gitignored)
└── (docelowo) shared/        ← typy TS współdzielone app ↔ server
                                 places.ts (Faza 2), baza danych
```

---

## 10. Otwarte decyzje (do ustalenia później)

1. **Auth od początku czy gość?** MVP można zrobić bez logowania (skan → wynik),
   auth dodać przy historii/ulubionych.
2. **Hosting backendu:** Cloudflare Workers vs Vercel vs Supabase Edge Functions.
3. **Zdjęcia dań:** start od trybu osobistego (Google Custom Search image) — patrz §4.
   Provider sklepowy do ustalenia przed publicznym wydaniem (decyzja prawno-produktowa).
4. **Monetyzacja:** darmowe skany z limitem + subskrypcja? (wpływa na rate limiting).
5. **Języki źródłowe:** Claude radzi sobie z wieloma — ustalić listę wspieranych
   języków docelowych UI.
```
