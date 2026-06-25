// Pobranie zdjęć (aparat / galeria — wiele naraz) + kompresja przed wysyłką.
// Czytamy też EXIF GPS (jeśli zdjęcie ma zaszyte współrzędne — np. zrobione na miejscu).
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat, type ImageRef } from "expo-image-manipulator";
import * as MediaLibrary from "expo-media-library";
import { File } from "expo-file-system";
import type { GeoPoint } from "./types";

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

/** Koduje zdjęcie pod dany `spec`: resize po DŁUŻSZEJ krawędzi do `spec.maxEdge` (BEZ upscalingu) + JPEG `spec.quality`.
 *  `dims` (z assetu pickera/kamery) pozwala pominąć sondujący render; brak → renderujemy raz po wymiary (replay/peek). */
async function encodeAt(uri: string, dims: { width?: number | null; height?: number | null } | undefined, spec: ImgSpec): Promise<{ uri: string; base64: string }> {
  let w = typeof dims?.width === "number" ? dims.width : undefined;
  let h = typeof dims?.height === "number" ? dims.height : undefined;
  let source: string | ImageRef = uri;
  if (!w || !h) {
    const probe = await ImageManipulator.manipulate(uri).renderAsync(); // dekoduj raz → poznaj wymiary
    w = probe.width;
    h = probe.height;
    source = probe; // reużyj zdekodowanego obrazu (manipulate przyjmuje ImageRef) — bez drugiego dekodowania
  }
  let ctx = ImageManipulator.manipulate(source);
  if (Math.max(w, h) > spec.maxEdge) {
    ctx = w >= h ? ctx.resize({ width: spec.maxEdge }) : ctx.resize({ height: spec.maxEdge });
  }
  const ref = await ctx.renderAsync();
  const r = await ref.saveAsync({ compress: spec.quality, format: SaveFormat.JPEG, base64: true });
  return { uri: r.uri, base64: r.base64 ?? "" };
}

/** Pomniejsza dowolny plik (np. hi-res sampel przy replayu) do rozmiaru DO MODELU (scan) → base64. */
export async function downscaleForModel(uri: string): Promise<string | null> {
  try {
    const r = await encodeAt(uri, undefined, scanSpec);
    return r.base64 || null;
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

async function compress(
  uri: string,
  exif?: Record<string, unknown> | null,
  dims?: { width?: number | null; height?: number | null },
): Promise<PreparedImage> {
  // STABILNY hash ŹRÓDŁA — md5 ORYGINAŁU (przed jakąkolwiek modyfikacją). Natywnie, synchronicznie.
  // Best-effort: gdy plik niedostępny → brak hasha → serwer po prostu nie cache'uje struktury tej fotki.
  let srcHash: string | undefined;
  try { srcHash = new File(uri).md5 ?? undefined; } catch { /* brak hasha = brak cache struktury */ }
  // DO MODELU (scan) — pomniejszone do spec serwera (dł. krawędź) + base64. `dims` z assetu = bez sondującego renderu.
  const model = await encodeAt(uri, dims, scanSpec);
  if (!model.base64) throw new Error("Nie udało się przygotować zdjęcia.");
  // DO SAMPLA — ORYGINAŁ VERBATIM (plik z aparatu/pickera, już JPEG). BEZ przekodowania: md5(sampla)=srcHash,
  // więc replay liczy ten sam hash z pliku (nie zapisujemy go w migawce). persistImage kopiuje ten plik 1:1.
  return {
    uri: model.uri,
    base64: model.base64,
    hiResUri: uri,
    srcHash,
    mediaType: "image/jpeg",
    exifLocation: exifToGeo(exif),
    takenAt: exifToTime(exif),
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

/** Robi zdjęcie aparatem (jedno). Zwraca null, gdy użytkownik anuluje. */
export async function captureFromCamera(): Promise<PreparedImage | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Brak zgody na użycie aparatu.");
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1, exif: true });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  void saveToGallery(a.uri); // tryb testowy: zachowaj oryginał w galerii (równolegle)
  return compress(a.uri, a.exif, { width: a.width, height: a.height });
}

/** Przetwarza zdjęcie zrobione WŁASNYM aparatem (tryb seryjny, expo-camera): kompresja
 *  + zapis oryginału do galerii (tryb testowy). `exif` z takePictureAsync. */
export async function prepareCameraPhoto(
  uri: string,
  exif?: Record<string, unknown> | null,
): Promise<PreparedImage> {
  void saveToGallery(uri); // równolegle, best-effort
  return compress(uri, exif ?? null);
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
