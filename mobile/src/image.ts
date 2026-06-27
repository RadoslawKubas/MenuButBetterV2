// Pobranie zdjęć (aparat / galeria — wiele naraz) + kompresja przed wysyłką.
// Czytamy też EXIF GPS (jeśli zdjęcie ma zaszyte współrzędne — np. zrobione na miejscu).
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat, type ImageRef } from "expo-image-manipulator";
import * as MediaLibrary from "expo-media-library";
import * as Location from "expo-location";
import { File } from "expo-file-system";
import { write as writeExif } from "@lodev09/react-native-exify";
import type { GeoPoint } from "./types";
import { recognizeOcr, boxFromOcr, type OcrData, type MenuBox } from "./menuRegion";

export interface PreparedImage {
  uri: string; // skompresowany plik — do podglądu miniatury
  base64: string; // wersja DO MODELU (pomniejszona) — tani payload
  /** ORYGINAŁ z telefonu VERBATIM (plik) — zapisywany do SAMPLA bez przekodowania (md5 sampla = srcHash). */
  hiResUri?: string;
  /** STABILNY hash ŹRÓDŁOWEGO (niezmodyfikowanego) zdjęcia — md5 oryginału z aparatu/galerii, liczony PRZED
   *  resize/JPEG. Wysyłany na serwer jako klucz cache struktury (nie zmienia się przez modyfikację → ponowny
   *  skan tego samego zdjęcia trafia). W migawce NIE zapisujemy — sampel to verbatim oryginał, więc replay
   *  liczy ten sam md5 z pliku (patrz captureSrcHash). */
  srcHash?: string;
  mediaType: "image/jpeg";
  /** Współrzędne z EXIF zdjęcia, jeśli były zaszyte. */
  exifLocation?: GeoPoint;
  /** Czas wykonania zdjęcia (EXIF DateTimeOriginal, epoch ms) — do sortowania stron najstarsze→najnowsze. */
  takenAt?: number;
  /** SUROWY on-device OCR PEŁNEGO zdjęcia (ML Kit) — liczony raz w `compress`: (a) z niego crop DO MODELU
   *  (box menu, „biały przerywany"), (b) zapisywany do sampla ZAWSZE razem ze zdjęciem (do eksperymentów w LABie). */
  ocr?: OcrData;
  /** Analiza menu-AI (CLIP/Apple/MLKit) PEŁNEGO zdjęcia i WYCINKA — liczona przez `runScan` przed wysyłką (fresh) lub
   *  dołączona z sampla (resume). Wysyłana RAZEM z wycinkiem na serwer (serwer GROMADZI; użycie/triaż = później). */
  menuAi?: unknown;
  menuAiCrop?: unknown;
}

// EXIF DateTimeOriginal („YYYY:MM:DD HH:MM:SS") → epoch ms. Brak/niepoprawne → undefined.
function exifToTime(exif: Record<string, unknown> | undefined | null): number | undefined {
  if (!exif) return undefined;
  const raw = exif.DateTimeOriginal ?? exif.DateTime ?? exif.DateTimeDigitized;
  if (typeof raw !== "string") return undefined;
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  return Number.isFinite(t) ? t : undefined;
}

// DWIE wersje zdjęcia:
//  • DO MODELU — pomniejszone (tani/szybki payload, dobry OCR). Resize po DŁUŻSZEJ krawędzi do SUFITU vision
//    aktywnego modelu skanu (spec z serwera /app-config → setModelImageSpec). Sufit to realna ściana czytelności
//    jednej klatki — wyżej i tak nie pomoże (Sonnet/Haiku tną do 1568, Opus 4.8 do 2576). Po dłuższej krawędzi
//    (nie po szerokości!) żeby pion „ściany z menu" nie kolapsował do wąskiej szerokości.
//  • DO SAMPLA — ORYGINAŁ z telefonu VERBATIM (plik z aparatu/pickera, już JPEG) — BEZ przekodowania. To NIE jest
//    ta wersja: sampel idzie z hiResUri (pełna jakość, jak zapis do galerii). md5 sampla = srcHash.
// Fallback (offline / stary serwer bez spec): 1568 px @ 0.82.
const FALLBACK_MAX_EDGE = 1568;
const FALLBACK_QUALITY = 0.82;
interface ImgSpec { maxEdge: number; quality: number }
// DWA miejsca w apce wysyłają obraz do RÓŻNYCH modeli → osobny spec dla każdego (serwer podaje oba):
//  • scan = wysyłka skanu (OCR/struktura).  • peek = „szybki podgląd" (kuchnia/nazwa), inny/tańszy model.
const scanSpec: ImgSpec = { maxEdge: FALLBACK_MAX_EDGE, quality: FALLBACK_QUALITY };
const peekSpec: ImgSpec = { maxEdge: FALLBACK_MAX_EDGE, quality: FALLBACK_QUALITY };

function applySpec(target: ImgSpec, edge?: number | null, quality?: number | null): void {
  if (typeof edge === "number" && Number.isFinite(edge) && edge >= 512 && edge <= 6000) target.maxEdge = Math.round(edge);
  if (typeof quality === "number" && Number.isFinite(quality) && quality > 0.3 && quality <= 1) target.quality = quality;
}

/** Ustawia SPEC zdjęć z /app-config — OSOBNO dla skanu i peeka (różne modele). Apka NIE musi znać modeli: serwer
 *  wylicza rozmiary i podaje liczby. Wartości spoza sensownego zakresu ignorowane (zostaje poprzednia/fallback). */
export function setModelImageSpec(spec: {
  imageMaxEdge?: number | null; imageQuality?: number | null;
  peekImageMaxEdge?: number | null; peekImageQuality?: number | null;
}): void {
  applySpec(scanSpec, spec.imageMaxEdge, spec.imageQuality);
  applySpec(peekSpec, spec.peekImageMaxEdge, spec.peekImageQuality);
}

// Crop „DO MODELU" = INTELIGENTNY box menu z on-device OCR (union ramek tekstu + mały margines; `boxFromOcr`).
// To dokładnie „biały przerywany" z nakładki LABu. Przycinamy PEŁNĄ klatkę do tego boxa PRZED skalowaniem do
// maxEdge → menu wypełnia więcej budżetu pikseli = lepszy OCR. ZAMIAST starego cięcia pasów góra/dół (scrimy).
// Sampel zostaje PEŁNĄ klatką (bez cropu). Boki też przycinane (box jest 2D, nie tylko góra/dół).

/** Koduje zdjęcie pod dany `spec`: (opcjonalny crop do `cropBox` znormalizowanego 0..1) → resize po DŁUŻSZEJ
 *  krawędzi do `spec.maxEdge` (BEZ upscalingu) + JPEG `spec.quality`. `dims` (z assetu) pomija sondujący render. */
async function encodeAt(uri: string, dims: { width?: number | null; height?: number | null } | undefined, spec: ImgSpec, cropBox?: MenuBox | null, rotate = 0): Promise<{ uri: string; base64: string }> {
  let w = typeof dims?.width === "number" ? dims.width : undefined;
  let h = typeof dims?.height === "number" ? dims.height : undefined;
  let source: string | ImageRef = uri;
  if (rotate) {
    // OBRÓĆ NAJPIERW (sampel zostaje w oryginalnej orientacji; do MODELU/analizy idzie pionowy). Po obrocie wymiary
    // się zmieniają, a cropBox jest w przestrzeni PIONOWEJ → sonduj wymiary po obrocie, potem crop.
    const rotated = await ImageManipulator.manipulate(uri).rotate(rotate).renderAsync();
    w = rotated.width; h = rotated.height; source = rotated;
  } else if (!w || !h) {
    const probe = await ImageManipulator.manipulate(uri).renderAsync(); // dekoduj raz → poznaj wymiary
    w = probe.width;
    h = probe.height;
    source = probe; // reużyj zdekodowanego obrazu (manipulate przyjmuje ImageRef) — bez drugiego dekodowania
  }
  let ctx = ImageManipulator.manipulate(source);
  if (cropBox) {
    const r = {
      originX: Math.max(0, Math.round(cropBox.x * w)),
      originY: Math.max(0, Math.round(cropBox.y * h)),
      width: Math.min(w, Math.round(cropBox.w * w)),
      height: Math.min(h, Math.round(cropBox.h * h)),
    };
    if (r.width > 0 && r.height > 0 && (r.width < w || r.height < h)) {
      ctx = ctx.crop(r);
      w = r.width;
      h = r.height;
    }
  }
  if (Math.max(w, h) > spec.maxEdge) {
    ctx = w >= h ? ctx.resize({ width: spec.maxEdge }) : ctx.resize({ height: spec.maxEdge });
  }
  const ref = await ctx.renderAsync();
  const r = await ref.saveAsync({ compress: spec.quality, format: SaveFormat.JPEG, base64: true });
  return { uri: r.uri, base64: r.base64 ?? "" };
}

/** Pomniejsza dowolny plik (np. hi-res sampel przy replayu) do rozmiaru DO MODELU (scan) → base64. `ocr` (zapisany
 *  w samplu) → crop DO MODELU = box menu (ten sam kadr co świeży skan); brak → pełna klatka, tylko pomniejszona. */
export async function downscaleForModel(uri: string, ocr?: OcrData | null, rotation = 0): Promise<string | null> {
  try {
    const box = ocr ? boxFromOcr(ocr) : null;
    const r = await encodeAt(uri, undefined, scanSpec, box, rotation);
    return r.base64 || null;
  } catch {
    return null;
  }
}

/** Zwraca plik DO PIONU (obrócony o `rotation`) — bez cropu, pełna klatka. Do analizy menu-AI na poprawnie
 *  zorientowanym obrazie, gdy sampel jest zapisany krzywo. rotation=0 → oryginalny uri (bez kosztu). */
export async function uprightFile(uri: string, rotation = 0): Promise<string> {
  if (!rotation) return uri;
  try { return (await (await ImageManipulator.manipulate(uri).rotate(rotation).renderAsync()).saveAsync({ compress: 1, format: SaveFormat.JPEG })).uri; }
  catch { return uri; }
}

/** Jak downscaleForModel, ale zwraca PLIK (file:// uri) wyciętego kadru DO MODELU (crop boxa OCR + pomniejszenie) —
 *  dla natywnych modeli (ML Kit/Apple/CLIP), które czytają z uri. null = błąd. */
export async function cropFileForModel(uri: string, ocr?: OcrData | null, rotation = 0): Promise<string | null> {
  try {
    const box = ocr ? boxFromOcr(ocr) : null;
    const r = await encodeAt(uri, undefined, scanSpec, box, rotation);
    return r.uri || null;
  } catch {
    return null;
  }
}

/** Przygotowuje base64 dla „szybkiego podglądu" (peek) — z ORYGINAŁU, w rozmiarze MODELU PEEKA (serwer). Osobno od
 *  skanu, bo to inny model (inny sufit). Liczone z hi-res, więc działa też gdy peek > scan (bez upscalingu z pliku scanu). */
export async function prepareForPeek(uri: string): Promise<string | null> {
  try {
    const r = await encodeAt(uri, undefined, peekSpec);
    return r.base64 || null;
  } catch {
    return null;
  }
}
// Górny, rozsądny limit liczby zdjęć na jeden skan (duże menu robimy partiami).
export const MAX_IMAGES = 40;
// Skan PER ZDJĘCIE (1): lepszy progres, recovery (powtarzamy tylko padłą fotkę) i live preview
// (dania z danej fotki dochodzą z pełnymi danymi). Koszt ≈ jak wsadowo dzięki prompt-cache +
// cache struktury/pozycji. Wyniki kolejnych fotek scalane z deduplikacją.
export const SCAN_BATCH = 1;

/** Wyciąga GPS z EXIF (best-effort — formaty różnią się między platformami). */
function exifToGeo(exif: Record<string, unknown> | undefined | null): GeoPoint | undefined {
  if (!exif) return undefined;
  const lat = exif.GPSLatitude;
  const lng = exif.GPSLongitude;
  if (typeof lat !== "number" || typeof lng !== "number") return undefined;
  const latRef = exif.GPSLatitudeRef;
  const lngRef = exif.GPSLongitudeRef;
  const latitude = latRef === "S" ? -lat : lat;
  const longitude = lngRef === "W" ? -lng : lng;
  if (!isFinite(latitude) || !isFinite(longitude)) return undefined;
  if (latitude === 0 && longitude === 0) return undefined;
  return { lat: latitude, lng: longitude };
}

// ML Kit czyta TYLKO pionowy tekst — menu obrócone o 90°/180° daje śmieci albo nic. Próbujemy 4 obrotów (detekcja
// na POMNIEJSZONEJ kopii = szybkie OCR-y), wybieramy ten z NAJWIĘCEJ rozpoznanego tekstu = prawidłowa orientacja.
// Szybka ścieżka: gdy 0° jest już czytelne (próg znaków), nie próbujemy reszty. Potem obracamy PEŁNY obraz raz do
// pionu i robimy FINALNE OCR (pełna rozdzielczość = dobre ramki). Zwraca: obraz DO PIONU (do modelu i sampla),
// OCR w tej pionowej ramce, wybrany kąt. Brak tekstu w żadnej orientacji → kąt 0, oryginał, ocr=null.
export async function ocrAutoOrient(uri: string): Promise<{ ocr: OcrData | null; rotation: number; uri: string }> {
  const textLen = (o: OcrData | null) => (o ? o.blocks.reduce((s, b) => s + b.text.replace(/\s/g, "").length, 0) : 0);
  // Pomniejszona baza do detekcji (orientacja nie zależy od rozdzielczości; mniejsze = szybsze OCR i obroty).
  let smallUri = uri;
  try {
    const probe = await ImageManipulator.manipulate(uri).renderAsync();
    const big = Math.max(probe.width, probe.height) > 1200;
    const ctx = big ? ImageManipulator.manipulate(probe).resize(probe.width >= probe.height ? { width: 1200 } : { height: 1200 }) : ImageManipulator.manipulate(probe);
    smallUri = (await (await ctx.renderAsync()).saveAsync({ compress: 0.6, format: SaveFormat.JPEG })).uri;
  } catch { /* zostaje oryginał do detekcji */ }
  let best = { sc: -1, rotation: 0 };
  for (const rot of [0, 90, 180, 270]) {
    let testUri = smallUri;
    if (rot) {
      try { testUri = (await (await ImageManipulator.manipulate(smallUri).rotate(rot).renderAsync()).saveAsync({ compress: 0.6, format: SaveFormat.JPEG })).uri; }
      catch { continue; }
    }
    const sc = textLen(await recognizeOcr(testUri).catch(() => null));
    if (sc > best.sc) best = { sc, rotation: rot };
    if (rot === 0 && best.sc >= 150) break; // 0° WYRAŹNIE czytelne → obraz już pionowy (próg wysoki, by bok z odrobiną tekstu nie udawał pionu)
  }
  // Zastosuj wybrany obrót do PEŁNEGO obrazu (raz) i policz finalne OCR na pełnej rozdzielczości.
  let finalUri = uri;
  if (best.rotation) {
    try { finalUri = (await (await ImageManipulator.manipulate(uri).rotate(best.rotation).renderAsync()).saveAsync({ compress: 1, format: SaveFormat.JPEG })).uri; }
    catch { finalUri = uri; }
  }
  const ocr = await recognizeOcr(finalUri).catch(() => null);
  return { ocr, rotation: best.rotation, uri: finalUri };
}

async function compress(
  uri: string,
  exif?: Record<string, unknown> | null,
  dims?: { width?: number | null; height?: number | null },
): Promise<PreparedImage> {
  // ORIENTACJA + OCR (raz): ML Kit czyta tylko pionowy tekst → wykryj prawidłowy obrót (najwięcej rozpoznanego
  // tekstu), ustaw obraz DO PIONU i policz OCR. Upright obraz służy i do modelu (crop boxa), i do sampla (pełna klatka).
  const oriented = await ocrAutoOrient(uri).catch(() => ({ ocr: null as OcrData | null, rotation: 0, uri }));
  const fullUri = oriented.uri; // pełny obraz JUŻ DO PIONU (=oryginał, gdy kąt 0)
  const ocr = oriented.ocr;
  // STABILNY hash ŹRÓDŁA — md5 obrazu DO PIONU (po korekcie). Replay trzyma sampel = ten sam pionowy obraz, więc
  // liczy ten sam md5 → cache struktury trafia. Best-effort: brak pliku → brak hasha → brak cache tej fotki.
  let srcHash: string | undefined;
  try { srcHash = new File(fullUri).md5 ?? undefined; } catch { /* brak hasha = brak cache struktury */ }
  const cropBox = ocr ? boxFromOcr(ocr) : null;
  // DO MODELU (scan) — crop do boxa OCR → pomniejszone do spec serwera (dł. krawędź ≤ maxEdge) + base64. dims
  // tylko gdy bez obrotu (po obrocie wymiary się zmieniają → encodeAt sam je sonduje).
  const model = await encodeAt(fullUri, oriented.rotation === 0 ? dims : undefined, scanSpec, cropBox);
  if (!model.base64) throw new Error("Nie udało się przygotować zdjęcia.");
  // DO SAMPLA — PEŁNA klatka DO PIONU (bez cropu). persistImage kopiuje ten plik 1:1; md5(sampla)=srcHash.
  return {
    uri: model.uri,
    base64: model.base64,
    hiResUri: fullUri,
    srcHash,
    mediaType: "image/jpeg",
    exifLocation: exifToGeo(exif),
    takenAt: exifToTime(exif),
    ocr: ocr ?? undefined,
  };
}

// Tryb testowy: zapisuje ORYGINAŁ zdjęcia (pełna rozdzielczość, z EXIF) w galerii telefonu.
// Best-effort — brak zgody / błąd NIE blokuje skanu (tylko nie zachowamy kopii w galerii).
async function saveToGallery(uri: string): Promise<void> {
  try {
    const perm = await MediaLibrary.requestPermissionsAsync(true); // writeOnly: tylko dodawanie
    if (perm.granted) await MediaLibrary.saveToLibraryAsync(uri);
  } catch {
    // ignorujemy — galeria to wygoda do debug, nie wymóg
  }
}

// Pozycja urządzenia do GEOTAGU — best-effort i NIEINWAZYJNA: TYLKO gdy zgoda na lokalizację już przyznana
// (NIE prosimy o nią tylko po to, by geotagować — lokalizacja jest opt-in, patrz location.ts). Najpierw
// ostatnio znana (natychmiast), potem ewentualnie świeży fix. Cache krótki: zdjęcia jednego menu robione
// seriami w tym samym miejscu, więc nie odpytujemy GPS przy każdej klatce. Cisza przy braku/błędzie.
let geoCache: { lat: number; lng: number; ts: number } | null = null;
async function deviceGeoIfAllowed(): Promise<{ lat: number; lng: number } | null> {
  try {
    if (geoCache && Date.now() - geoCache.ts < 60_000) return geoCache;
    const perm = await Location.getForegroundPermissionsAsync(); // SPRAWDŹ status, NIE proś
    if (!perm.granted) return null;
    const pos =
      (await Location.getLastKnownPositionAsync()) ??
      (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    if (!pos) return null;
    geoCache = { lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() };
    return geoCache;
  } catch {
    return null;
  }
}

// Wpisuje GPS urządzenia w EXIF pliku (file://) NASZEGO zdjęcia — dzięki temu kopia do galerii i ORYGINAŁ
// zapisany w samplu są geotagowane (expo-camera nie geotaguje sam). Modyfikuje plik W MIEJSCU (dla file:// uri
// `write` zwraca ten sam uri), więc dalej `compress` liczy srcHash z już-geotagowanego pliku (replay spójny).
// GPS w EXIF to magnituda + ref (N/S, E/W) — stąd abs()+ref. Best-effort: HEIC/format/IO/brak GPS → bez geotagu.
async function geotagOwnPhoto(uri: string): Promise<void> {
  const geo = await deviceGeoIfAllowed();
  if (!geo) return;
  try {
    await writeExif(uri, {
      GPSLatitude: Math.abs(geo.lat),
      GPSLatitudeRef: geo.lat >= 0 ? "N" : "S",
      GPSLongitude: Math.abs(geo.lng),
      GPSLongitudeRef: geo.lng >= 0 ? "E" : "W",
    });
  } catch {
    // EXIF się nie zapisał (np. HEIC / format / IO) — zostaje oryginał bez geotagu
  }
}

/** Robi zdjęcie aparatem (jedno). Zwraca null, gdy użytkownik anuluje. */
export async function captureFromCamera(): Promise<PreparedImage | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Brak zgody na użycie aparatu.");
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1, exif: true });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  await geotagOwnPhoto(a.uri); // NASZE zdjęcie → wpisz device GPS w EXIF PRZED zapisem do galerii i do sampla
  void saveToGallery(a.uri); // tryb testowy: zachowaj oryginał w galerii (równolegle)
  return compress(a.uri, a.exif, { width: a.width, height: a.height }); // model: crop do boxa OCR; sampel: pełna klatka
}

/** Przetwarza zdjęcie zrobione WŁASNYM aparatem (tryb seryjny, expo-camera): kompresja
 *  + zapis oryginału do galerii (tryb testowy). `exif` z takePictureAsync. */
export async function prepareCameraPhoto(
  uri: string,
  exif?: Record<string, unknown> | null,
): Promise<PreparedImage> {
  await geotagOwnPhoto(uri); // NASZE zdjęcie → device GPS w EXIF PRZED galerią i samplem
  void saveToGallery(uri); // równolegle, best-effort
  return compress(uri, exif ?? null, undefined); // model: crop do boxa OCR; sampel: pełna klatka
}

/** Wybiera z galerii — MOŻNA WIELE. Zwraca [] gdy anulowano. */
export async function pickFromLibrary(): Promise<PreparedImage[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error("Brak zgody na dostęp do galerii.");
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: MAX_IMAGES,
    quality: 1,
    exif: true,
  });
  if (res.canceled) return [];
  return Promise.all(res.assets.map((a) => compress(a.uri, a.exif, { width: a.width, height: a.height })));
}
