# Menu dnia / zestawy — diagnoza, fix promptu, walidacja, plan

Status: **fix gotowy w `server/src/menu.ts`, NIEWDROŻONY** (na życzenie — eksperymenty lokalne).
Apka: **bez zmian** (render zestawów już istnieje). Data: 2026-06-25.

## Problem (na przykładzie La Cata)
„Menú del Día" z pod-nagłówkami PRIMEROS / SEGUNDOS (wybierasz 1+1 za 19,50€) był rozbijany na
**2 osobne sekcje à la carte**, a notki zestawu (cena/wliczone) wisiały `scope='menu'` (oderwane).
Efekt: gość nie widział, że to jeden zestaw o stałej cenie. Model DOBRZE tagował `course`/`price=null`/
`surcharge` — gubił tylko grupowanie (brał nagłówki kursów za sekcje).

## Fix (prompt, ~7 linii w menu.ts → instrukcja ZESTAWY/MENU DNIA)
- CAŁY zestaw = **JEDNA sekcja**, `name` = nazwa menu z karty (np. „Menú del Día — Viernes").
- Pod-nagłówki kursów (PRIMEROS/SEGUNDOS/POSTRES, Starters/Mains/Desserts) → wartość **`course`**, NIE osobne sekcje.
- Każde danie do wyboru = pozycja z `course` ('1. danie'/'2. danie'/'deser'), `price=null`, `surcharge` przy dopłatach.
- Cena+wliczone+dzień → **jedna `set`-notka `scope='section'`** przy tej sekcji (nie rozbijaj na notki `menu`).

## Walidacja (lokalnie, model produkcyjny Sonnet, świeżo, bez cache)
| sampel | zestaw | à la carte | uwagi |
|---|---|---|---|
| La Cata | Menú del Día Viernes → **1 sekcja, 2 kursy** (3/3 stabilnie) | — | dopłaty +6,80/+5,80€ OK |
| Mar de Tapes | Menú del Día 19€ → **1 sekcja, 3 kursy** (1./2./deser, 19 poz.) | 11 sekcji osobno | notki: „wt-pt do 16:00, bez świąt" + „Bebida, pan, postre/café incluidos" |
| Bliss | Menú del Día → **1 sekcja, 2 kursy** | 8 sekcji osobno | — |
| Indian Taste | lunch-set → **1 sekcja** + set/included | drinks osobno | nazwa sekcji bywa pusta (patrz niżej) |
| Bonna Boca | brak | 6 sekcji | brak fałszywego zestawu |
| Sztuka Mleka | brak | **12 sekcji nietknięte** | brak over-merge |

Wniosek: działa na 2-/3-kursowych i lunch-setach, **bez regresji à la carte**, notki przy sekcji.

## Apka — render już gotowy (MenuView)
- `isSet` = sekcja ma `course` lub notkę `set` → wspólna ramka `setSection`.
- Pod-nagłówki kursów (zwijane), notki `set`/`included` pod sekcją, `availability` z ikoną zegara.
→ Fix jest **czysto serwerowy (prompt)**, bez rebuildu apki.

## Znane/drobne (do decyzji)
1. **Nazwa sekcji-zestawu bywa pusta** dla lunch-setów bez nagłówka „Menú del día" (Indian Taste: raz „28 Lunch Opcji", raz puste). Można wzmocnić prompt („gdy brak nagłówka, nazwij 'Menu lunchowe'/'Zestaw'").
2. Cena bywa zdublowana (w `name` „…19€" i w `set`-notce) — kosmetyka, raczej pomaga.
3. `set` + `included` jako 2 notki (nie scalone) — OK, render pokazuje obie pod sekcją.
4. **Sushi Mirage / mqnor4xt: „menu za duże" (limit tokenów)** — OSOBNY problem gęstych pojedynczych zdjęć, nie zestawów.

## Plan (rekomendacja)
1. **Wdrożyć fix promptu** na prod — `cd server && railway up` (serwerowo, bez rebuildu apki). Niskie ryzyko: zwalidowane na 5 zróżnicowanych zestawach + kontrole à la carte, render apki gotowy.
2. (opcjonalnie, mały prompt) Wzmocnić **nazewnictwo sekcji-zestawu** dla lunch-setów bez „Menú del día".
3. (osobny temat) **Gęste menu > limit tokenów**: paginacja/auto-podział strony albo wyższy `max_tokens`/Opus dla gęstych skanów (Sushi Mirage, mqnor4xt) — niezależne od zestawów.
4. (opcjonalnie przed deployem) Szersza regresja struktury na 29 samplach (koszt ~$3-5) — przy wąskim zakresie zmiany i zdanych kontrolach raczej zbędne.

## Pliki
- Zmiana: `server/src/menu.ts` (instrukcja ZESTAWY/MENU DNIA). Niewdrożona, niezacommitowana.
- Narzędzie regresji promptu: `server/_exp_robust.ts` (zostaje).
