# MenuButBetter — backend (PoC)

PoC Fazy 0: zdjęcie menu → Claude vision → strukturyzowane menu (JSON), plus
opcjonalne wyszukiwanie zdjęć dań (tryb osobisty, Google Custom Search).

## Szybki start

```bash
cd server
npm install
cp .env.example .env        # i uzupełnij ANTHROPIC_API_KEY
```

Wrzuć zdjęcie menu (jpg/png/webp) np. do `server/samples/menu.jpg`, potem:

```bash
# Sam odczyt + tłumaczenie menu:
npm run scan -- samples/menu.jpg --lang polski

# Z podpowiedzią o lokalu (poprawia kontekst i trafność zdjęć):
npm run scan -- samples/menu.jpg --lang polski --hint "Trattoria Roma, Kraków"

# Ze zdjęciami dań (wymaga GOOGLE_CSE_KEY i GOOGLE_CSE_CX w .env):
npm run scan -- samples/menu.jpg --hint "Trattoria Roma, Kraków" --photos
```

Wynik: czytelne menu na ekranie + pełny JSON na końcu (można przekierować:
`npm run scan -- samples/menu.jpg > /dev/null 2> menu.json` da sam JSON na stdout).

## Klucze API

| Zmienna | Do czego | Skąd |
|---|---|---|
| `ANTHROPIC_API_KEY` | odczyt menu (Claude) | https://console.anthropic.com → API Keys |
| `GOOGLE_CSE_KEY` | wyszukiwanie zdjęć dań | https://developers.google.com/custom-search/v1/overview |
| `GOOGLE_CSE_CX` | ID wyszukiwarki (z włączonym „Image search" + „Search the entire web") | https://programmablesearchengine.google.com |

## Pliki

| Plik | Rola |
|---|---|
| `src/schema.ts` | JSON Schema + typy TS strukturyzowanego menu |
| `src/menu.ts` | wywołanie Claude vision (model `claude-sonnet-4-6`) |
| `src/dishPhotos.ts` | `DishPhotoProvider` + provider Google CSE (wymienialny) |
| `src/runScan.ts` | runner CLI |

## Dalej

- Faza 1: opakować `extractMenuFromBase64` w endpoint HTTP (serverless) + aplikacja Expo.
- Re-ranking zdjęć dań przez Claude vision (odfiltrowanie złych trafień).
- Cache menu po hashu zdjęcia (oszczędność kosztów LLM).
