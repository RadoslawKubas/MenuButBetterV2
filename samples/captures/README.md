# Próbki skanów (captures)

Tu wrzucaj pliki wyeksportowane z aplikacji: ekran **🧪 Tryb testowy → ⬆︎ Wyeksportuj
wszystkie do pliku**. Każdy plik to samodzielny JSON `mbb-captures-<data>.json`.

## Format

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
        { "mediaType": "image/jpeg", "exifLocation": { "lat": …, "lng": … }, "base64": "<JPEG inline>" }
      ]
    }
  ]
}
```

Zdjęcia menu są inline w base64 — plik jest samowystarczalny (nie potrzeba osobnych
plików). To dokładnie to, co poleciało do `/scan`, więc na tym można odtwarzać i
debugować skany lokalnie.
