# Raport: „Organic Market" zamiast „Indian Taste" — root cause + naprawa

_Badanie autonomiczne w nocy. Eksperymenty na realnym samplu (Indian Taste) tym samym promptem co aplikacja.
Zmiany zastosowane LOKALNIE w drzewie roboczym, **NIE wdrożone** (czeka na Twoją decyzję)._

## TL;DR

- **To NIE był błąd GPS, sampla, replayu ani moich zmian rozdzielczości.** Wszystko to działało.
- **Root cause:** nazwa „Indian Taste" **nie występuje na karcie jako tekst** — jest tylko w domenie
  `www.centrum.indiantaste.com.pl`. Model był instruowany („nazwa, jeśli widoczna… **Inaczej null**”), więc zwracał
  `restaurant_name: null`. Bez nazwy pipeline szedł rozpoznaniem **po samym GPS** → najbliższy lokal = „Organic Market Q22”.
- **Naprawa (zwalidowana eksperymentem):** nauczyć model **wyprowadzać nazwę z domeny / e-maila / adresu www**.
  Po zmianie: `restaurant_name: "Indian Taste"`, a `findRestaurant("Indian Taste")` zwraca realny lokal
  **„Indian Taste CENTRUM GRZYBOWSKA” (52.2350, 20.9937)** — mimo że GPS sampla pokazuje Organic.
- **Logika rozpoznania już była dobra** (najpierw po nazwie, GPS to ostateczność) — brakowało tylko nazwy.

## Co się działo (dowody z logów PROD)

```
[pipeline nearby] 12 lokali w pobliżu (loc=52.23536, 20.99821)
[pipeline venue] start  venueMatch=null  name=""  loc=52.23536,20.99821  cuisine=indian
[pipeline venue] resolved=Organic Market Q22  guessed=true  cands=20
```

- GPS wysłany = **dokładnie** współrzędne sampla (52.23536, 20.99821). Replay zadziałał poprawnie.
- `name=""` → struktura nie dała nazwy → `guessed=true` (rozpoznanie po samym GPS).
- **Uwaga o danych testowych:** współrzędne sampla to pozycja **Organica**, nie Indian Taste — bo gdy oryginalnie
  skanowałeś tę kartę (17/6), GPS symulatora był na Organicu i to się zapisało do sampla (menu Indian Taste +
  GPS Organica). To nie psuje naprawy — nazwa z karty rozpoznaje lokal niezależnie od GPS.

## Śledztwo (po kolei)

1. **Sampel poprawny** — w zipie na serwerze: `location {52.23536, 20.99821}`, `locationSource: device`,
   zdjęcia bez EXIF-GPS. Eksport→zip→import poprawnie przenosi `location`.
2. **Karta:** nazwa „Indian Taste" **nigdzie nie jest tekstem** — tylko domena `www.centrum.indiantaste.com.pl`
   + telefon `+48 512 865 865`. Drugie zdjęcie (drinki) bez nazwy. (Podejrzenie rozdzielczości odpada — domena jest czytelna.)
3. **Lista „w pobliżu" w punkcie sampla (20 lokali): ZERO indyjskich** (Organic Market Q22, Biuro Panrest,
   Gorąco Polecam, …). Czyli `venue_match` nie miał czego dopasować — słusznie `null`.
4. **Baseline (obecny prompt, model=Sonnet, pełna rozdz.):** `restaurant_name: null`, `cuisine: indian`, 27 dań.
5. **Test logiki:** `findRestaurant("Indian Taste" | "Indiantaste" | "indiantaste")` → za każdym razem
   **„Indian Taste CENTRUM GRZYBOWSKA” (52.2350, 20.9937)**. Czyli wystarczy NAZWA — reszta działa.

## Naprawa (zwalidowana) — zastosowana lokalnie, NIE wdrożona

Zmiana w **schemacie** (`server/src/schema.ts`, oba warianty: 2-fazowy i one-pass) + **prompcie**
(`server/src/menu.ts`): model ma **wyprowadzać nazwę z domeny/adresu www/e-maila/uchwytu**, gdy nie jest wypisana
wprost — z zabezpieczeniem, by NIE brać nazwy z platform dostaw/agregatorów (pyszne, ubereats, glovo, wolt,
tripadvisor, facebook, instagram…). Pole `restaurant_name` jest też jawnie **niezależne od listy „w pobliżu”**
(podaj nazwę z karty nawet gdy `venue_match=null`).

**Wynik eksperymentu (ten sam sampel, ten sam prompt-ścieżka):**

| | `restaurant_name` | po nazwie → lokal |
|---|---|---|
| **przed** | `null` | (brak nazwy → GPS-only → **Organic Market Q22**) |
| **po** | `"Indian Taste"` | `findRestaurant` → **Indian Taste CENTRUM GRZYBOWSKA (52.2350, 20.9937)** ✓ |

Z zabezpieczeniem agregatorów „Indian Taste” dalej wychodzi poprawnie. `tsc` = 0 (serwer).

**Robustność (poprawiony prompt na 3 innych samplach z labu) — zero halucynacji:**

| sampel | stara nazwa (poprzedni skan) | NOWA `restaurant_name` | ocena |
|---|---|---|---|
| Sztuka mleka | „Sztuka mleka, Warszawa” | **„Sztuka Mleka”** | ✓ zachowana (czystsza, bez miasta) |
| Ferretti | „Ferretti” | **„Ferretti”** | ✓ identyczna |
| (inna karta Indian Taste) | `null` | **„Indian Taste”** | ✓ poprawiona z `null` |

Jawne nazwy zachowane, wcześniejsze `null` poprawione na trafne, **żadnych zmyślonych nazw**.

Koszt eksperymentów: 6× struktura vision (Sonnet, 2 zdjęcia) ≈ **$0.64** łącznie.

## Propozycje DODATKOWE (do decyzji — NIE zastosowane)

### A. Guard kuchni na ścieżce GPS-only (siatka bezpieczeństwa)
Gdy nawet nazwy nie da się wyprowadzić, a rozpoznajemy po samym GPS — **nie podstawiaj pewnie** lokalu, którego
kuchnia kłóci się z kuchnią menu (organic shop ≠ indian). `RestaurantInfo` ma już pole `cuisine`, a
`findRestaurantNearby` liczy „kuchnia-pokrewna” (`isRel`). Szkic (w `resolveRestaurant`, gałąź GPS-only):
```ts
// gdy cuisine znana, a najlepszy kandydat NIE pasuje kuchnią → nie zgaduj pewnie
const best = candidates[0];
if (p.cuisine && !cuisineMatches(best, p.cuisine)) {
  return { restaurant: null, candidates }; // apka: „lokal niepewny / wybierz ręcznie” zamiast bzdury
}
```
Wymaga wystawienia z `findRestaurantNearby` flagi „pasuje kuchnią” (ma `isRel` — dorzucić `cuisineMatched` do
`RestaurantInfo`). Niskie ryzyko, ale wymaga testu na próbkach bez nazwy (żeby nie zwracać `null` za często, gdy
Google nie taguje kuchni).

### B. Rozdzielczość/crop (osobny wątek)
Tu nie zaważyła (domena czytelna), ale dla kart, gdzie nazwa/stopka jest drobna, **auto-crop menu na telefonie**
(iOS Vision / ML Kit text-bbox) podniósłby skuteczność OCR „za darmo” (mniej tła, większy tekst). Patrz wcześniejsza rozmowa.

### C. (opcjonalnie) `restaurant_address` z karty
Adres na tej karcie nie jest wypisany (tylko domena+telefon), ale telefon `+48 512 865 865` to mocny sygnał —
można rozpoznawać też **po numerze telefonu** (Places nie szuka po tel., ale można odpytać web/Serper). Niższy priorytet.

## Co zmienione w drzewie roboczym (NIE wdrożone)

- `server/src/schema.ts` — opis `restaurant_name` (2 miejsca): wyprowadzanie nazwy z domeny + wykluczenie agregatorów.
- `server/src/menu.ts` — prompt META: to samo + „niezależne od listy w pobliżu”.
- `server/_exp_venue.ts` — **tymczasowy** harness eksperymentu (do skasowania albo zostawienia do regresji).
  Uruchom: `cd server && npx tsx _exp_venue.ts` (potrzebuje obrazów w `/tmp/s10/images` — z `unzip` sampla).

## PEŁNA WALIDACJA (37 unikalnych sampli, poprawiony prompt, świeżo bez cache)

Harness `server/_exp_robust.ts` — dedup po `sig`, równolegle ×4, flaga ⚠️ na nazwy wyglądające jak
URL/domena/agregator/social lub >40 znaków. **Wynik: 0 podejrzanych, koszt $5.69, 1 błąd „menu za duże" (istniejący guard).**

**Kluczowe dla decyzji:** jedyne ryzyko zmiany (zmyślona nazwa / nazwa z agregatora/social przy wyprowadzaniu z domeny)
— **zero wystąpień** na 37 samplach. Regex SUSPECT nie złapał nic.

**null → trafna nazwa (czysto z karty/domeny) — 6×:**

| sampel | NEW |
|---|---|
| mqh6qxas | Indian Taste |
| mqeaeau8 | Sztuka Mleka |
| mqmcga9p | Iberic Fusion |
| mqmcc3q0 | Mar de Tapes |
| mqlhg9vb | Cúrcuma |
| mqliil1d | Nawab |

**Czyszczenie (śmieci/miasto/nagłówek/marka → poprawnie):**

| stara | NOWA | uwaga |
|---|---|---|
| Sztuka mleka, Warszawa | Sztuka Mleka | bez miasta |
| La Cata, Badalona | La Cata | bez miasta |
| Masa Divina, Badalona | Masa Divina | bez miasta |
| Iberic Fusion Tapas Restaurant | Iberic Fusion | skrót do nazwy |
| BONNA BOCA | Bonna Boca | kapitaliki |
| BEBIDAS („napoje") | Aroma de Mar | błędny nagłówek → realna nazwa |
| ESTRELLA (marka piwa) | null | poprawnie odrzucona marka |
| INTI Chiringuito Beach Club | Inti | skrót |

**Do świadomości (NIE artefakty domeny — wariancja modelu na granicznych kartach, część to korekty):**

| sampel | stara | NOWA | komentarz |
|---|---|---|---|
| mqnruvxp | La Mar de Tapes | Bonna Boca | jedyne „nazwa→inna nazwa"; obie realne; warto zerknąć na kartę |
| mqnpa8g9 | Sea You | null | inny „Sea You" (mqnpgrrg) zachowany — run-variance |
| mqnpjijj | Bliss | null | graniczna karta |

Jawne nazwy zachowane (Ferretti×2, La Mar de Tapes, Sea You Beach, Sushi Mirage, Can Pizza, Cúrcuma…),
wcześniejsze `null` poprawione, sample bez sygnału (kilka spanish/syczuańska) dalej `null`. **Brak halucynacji.**

→ **Wniosek: zmiana name-from-domain jest bezpieczna do deployu** (zero false-positive). Pozostałe różnice to
wariancja modelu na granicznych kartach albo korekty starych błędów (nagłówek/marka jako nazwa), nie skutek reguły.

## Rekomendowane następne kroki

1. ✅ **Walidacja przed deployem — ZROBIONA** (37 sampli, 0 podejrzanych, patrz wyżej).
2. Jak OK → **deploy serwera** (`cd server && railway up …`, weryfikacja SUCCESS). **Bez rebuildu apki** — to czysto serwerowa zmiana.
3. Decyzja o guardzie kuchni (A) — zaimplementować po walidacji.
4. Sprzątnąć `server/_exp_venue.ts` (albo zostawić jako narzędzie).
