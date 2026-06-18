# LAB modeli (lokalny)

Lokalne narzędzie do porównywania modeli na **wyeksportowanych migawkach** (tryb testowy apki).
Reużywa logikę produkcyjną z `server/src` (extractMenu, quickPeek, findRestaurant) i klucze z `server/.env`.

## Użycie
1. W apce: Migawki → „Wyeksportuj do ZIP" → rozpakuj do `server/samples/captures/<nazwa>/`
   (folder ma zawierać `metadata.json` + `images/`).
2. W `server/`:  `npm run lab`
3. Otwórz **http://localhost:8799**

Domyślnie bierze najnowszy folder z `samples/captures/`. Inny: `LAB_DIR=/ścieżka npm run lab`.

## Co umie
- **Mapa** (OSM): lokalizacje migawek (EXIF/GPS) + oznaczony prawdziwy lokal.
- **Ground‑truth**: „📍 Lokal" → szukasz w Google Places i wskazujesz PRAWDZIWĄ restaurację
  (zapis do `samples/.../ground-truth.json`). Dzięki temu testy wiedzą, czy pipeline trafił.
- **Run**: wybierasz modele + operacje (`peek`, `scan`, opcjonalnie `venue`) i puszczasz te same
  operacje na zaznaczonych migawkach. Wynik per model: koszt, czas, #dań, kuchnia, lokal, trafienie GT.
- **Sędzia**: silny model porównuje odczyty menu (z obrazem) → ocena kompletność/trafność per model,
  `best` i `good‑enough` (najtańszy wystarczający). Wynik zapisywany w `lab/results/`.

## Uwaga
To narzędzie LOKALNE (nie idzie na Railway). Realnie wydaje $ na API przy „Run"/„Sędzia" — patrz koszty w wynikach.
