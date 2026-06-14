# Próbki skanów (captures)

Tu wrzucaj archiwa wyeksportowane z aplikacji: ekran **🧪 Tryb testowy → ⬆︎ Wyeksportuj
wszystkie do ZIP**. Każdy plik to `mbb-captures-<data>.zip`.

## Zawartość archiwum

```
mbb-captures-2026-06-14T10-00-00.zip
├── metadata.json          # ustawienia + pozycja GPS każdej migawki
└── images/
    ├── <id>-0.jpg         # surowe zdjęcia menu (gotowe do obejrzenia)
    └── <id>-1.jpg
```

## metadata.json

```jsonc
{
  "format": "menubutbetter.captures",
  "version": 1,
  "exportedAt": 1718380800000,   // epoch ms eksportu
  "count": 3,
  "captures": [
    {
      "id": "…",
      "createdAt": 1718380000000,
      "targetLang": "polski",
      "model": "claude-sonnet-4-6",
      "restaurantHint": "Trattoria da Marco",   // opcjonalnie
      "locationHint": "Florencja, Włochy",       // „Miasto, Kraj" przekazane modelowi
      "location": { "lat": 43.7696, "lng": 11.2558 },  // dokładna pozycja, która poszła; albo null
      "locationSource": "device",                // "exif" | "device" | null
      "useExifLocation": true,
      "useDeviceLocation": true,
      "images": [
        { "file": "images/<id>-0.jpg", "mediaType": "image/jpeg", "exifLocation": { "lat": …, "lng": … } }
      ],
      "result": {                       // WYNIK skanu (z historii) — do analizy „co źle"
        "restaurantName": "…",
        "cuisine": "…",
        "restaurant": { … },            // dopasowany lokal (Google Places), jeśli był
        "usage": { … },                 // tokeny + koszt skanu
        "menu": { … }                   // pełne przetłumaczone menu + zdjęcia/opisy dań
      }
    }
  ]
}
```

Pole `result` to migawka skanu z historii w chwili eksportu — jeśli skan jeszcze dociągał
zdjęcia/opisy w tle, wyeksportuj ponownie, by złapać komplet. Brak `result` = skan został
usunięty z historii.

Zdjęcia menu leżą jako osobne pliki w `images/` (odwołania w `metadata.json` przez pole
`file`). To dokładnie to, co poleciało do `/scan`, więc na tym można odtwarzać i
debugować skany lokalnie.
