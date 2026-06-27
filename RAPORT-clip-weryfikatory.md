# Raport — weryfikatory zdjęć + zastosowania CLIP on-device

Data: 2026-06-26. Apka jest **testowa** (produkcyjna powstanie osobno), więc wszystko nastawione na eksperyment i porównanie.

---

## 1. Co powstało — w skrócie

Zbudowaliśmy **benchmark lokalnych modeli do oceny zdjęć dań** (zamiast płatnej weryfikacji vision, którą masz wyłączoną) + pierwsze **produkcyjne zastosowania CLIP** na telefonie. Wszystko liczone on-device (0 zł za zapytanie).

Trzy weryfikatory oceniają te same zdjęcia, werdykty lecą na serwer, a w LABie porównujesz je obok siebie i oznaczasz „dobre/złe" — z czego liczona jest **zgodność każdego modelu z Tobą**.

---

## 2. Weryfikatory (3 kolumny w 🔬 Weryfikatory)

| Weryfikator | Co robi | Sygnał |
|---|---|---|
| `mlkit-label` | ML Kit Image Labeling (cross-platform) | „czy to jedzenie/danie" (food-score) |
| `apple-vision` | Apple Vision natywny | klasyfikacja jedzenia + **`isUtility`** (grafika/logo/dokument → nie danie) + estetyka |
| `clip` | **MobileCLIP** (Apple, Core ML) | **dopasowanie zdjęcie↔NAZWA dania** — jedyny, który sprawdza „czy to TO danie" |

- `apple-vision`: gdy `isUtility=true` (paragon/logo/screenshot) score zbijany do ≤0.1.
- `clip`: dostaje prompt `a photo of {nazwa}`, cosine (~0.1–0.35) skalowany do 0..1.

---

## 3. Architektura (Fazy 0–3 — wszystkie wdrożone)

- **Serwer (prod, Railway):** tabela `photo_verdicts (dish,url,evaluator,platform,score,label,meta,install_id)` — nic nie kasujemy. Endpointy `POST /photo-feedback` (apka), `POST /photo-verdict` (ground-truth z LABu), `GET /photo-verdicts`.
- **LAB:** zakładka **🔬 Weryfikatory** — grupy (danie, url): miniatura + „🔎 szukane: {nazwa}" + score każdego modelu obok siebie + przycisk „✓ dobre / ✗ złe" + **podsumowanie zgodności** per model.
- **Apka:** po każdym zdjęciu dania uruchamia wszystkie weryfikatory i odsyła werdykty (poza UI, dedupe).

---

## 4. NOWE: zastosowania CLIP on-device (praca autonomiczna)

Teraz, gdy mamy lokalny CLIP, użyliśmy go do realnych rzeczy (nie tylko benchmarku):

**#1 — Pre-filtr „czy to menu" PRZED płatnym skanem** ✅
- Przed skanem CLIP sprawdza pierwsze zdjęcie: „a restaurant menu" vs „a plate of food / receipt / random photo…".
- Gdy WYRAŹNIE nie menu → pyta „Skanować mimo to? Skan kosztuje". → **oszczędza zmarnowane skany** na przypadkowych zdjęciach.
- Best-effort: brak CLIP / niepewność → leci normalnie (nie blokuje fałszywie).

**#3 + #4 — Dedup + ranking zdjęć dania** ✅
- Po pobraniu kandydatów: embedding obraz↔obraz → odrzuca **near-duplikaty** (cosine > 0.96), potem **szereguje wg dopasowania do nazwy dania** (najlepsze na górze).
- Działa na buforze po `id` → **finalne menu** dostaje odszumiony, lepiej ułożony zestaw. Pozycje z ★ (z lokalu) pomijane (★ ma pierwszeństwo). Best-effort, poza UI.

**#2 — lokalna kuchnia z CLIP — ŚWIADOMIE POMINIĘTE** ⚠️
- CLIP nie czyta tekstu, a menu to głównie tekst → kuchni z kartki nie wywnioskuje. To robota dla vision/OCR. Nie wpinaliśmy.

**Prymitywy natywne:** moduł `mobileclip` ma teraz `match`, `classify(url, labels[])` (zero-shot) i `embed(url)` — gotowe pod kolejne zastosowania.

---

## 5. Build i rozmiar

- **Przed CLIP:** ~47 MB.
- **Po CLIP:** ~140 MB (+93 MB) — głównie enkoder tekstu MobileCLIP S0 (85 MB) + obrazu (22 MB).
- Dla testów OK. Jak rozmiar zacznie przeszkadzać: kwantyzacja int8, mniejszy wariant, albo dociąganie modelu z serwera zamiast w paczce.

---

## 6. Co przetestować po wgraniu

1. **Skan z telefonu** → w LABie 🔬 Weryfikatory pojawią się grupy zdjęć z 3 kolumnami ocen. Oznaczaj „dobre/złe" → patrz zgodność każdego modelu.
2. **Zrób zdjęcie NIE-menu** (np. talerz, krajobraz) i spróbuj skanować → powinien wyskoczyć alert „To nie wygląda na menu".
3. **Skan z dużą liczbą zdjęć dań** → w finalnym menu zobacz, czy zdjęcia są mniej zduplikatów i lepiej dopasowane do dania.

---

## 7. Otwarte / do decyzji

- **Wybór zwycięzcy weryfikatora** — po nazbieraniu ocen w LABie zdecyduj, który model wygrywa → wtedy wepniemy **serwerowe filtrowanie słabych** zdjęć (cache vision-url) w pipeline.
- **Rozmiar apki (140 MB)** — czy zostawiamy, czy kwantyzujemy / dociągamy model z serwera.
- **#3/#4 w hot-path** — re-ranking liczony w tle podczas skanu; jak zauważysz spowolnienie na telefonie, można go ograniczyć (np. tylko top-N dań).
- Ryzyko: cały moduł CLIP (tokenizer + Core ML) **nie był testowany runtime** — build przeszedł, ale realne wyniki cosine zobaczymy dopiero na danych. Jeśli `clip` daje dziwne liczby, najpewniej tokenizer — poprawimy.
