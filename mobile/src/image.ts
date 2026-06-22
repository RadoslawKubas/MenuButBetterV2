// Pobranie zdjęć (aparat / galeria — wiele naraz) + kompresja przed wysyłką.
// Czytamy też EXIF GPS (jeśli zdjęcie ma zaszyte współrzędne — np. zrobione na miejscu).
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as MediaLibrary from "expo-media-library";
import { File } from "expo-file-system";
import type { GeoPoint } from "./types";

export interface PreparedImage {
  uri: string; // skompresowany plik — do podglądu miniatury
  base64: string; // wersja DO MODELU (pomniejszona) — tani payload
  /** Wersja HI-RES (plik) — zapisywana do SAMPLA, do późniejszego strojenia rozmiarów/jakości. */
  hiResUri?: string;
  /** STABILNY hash ŹRÓDŁOWEGO (niezmodyfikowanego) zdjęcia — md5 oryginału z aparatu/galerii, liczony
   *  PRZED resize/JPEG. Wysyłany na serwer jako klucz cache struktury (nie zmienia się przez modyfikację →
   *  ponowny skan tego samego zdjęcia trafia). Niesiony też w migawce, by replay/lab dał ten sam klucz. */
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
//  • DO MODELU — pomniejszone (tani/szybki payload, dobry OCR): 2000px @ 0.72.
//  • DO SAMPLA — ORYGINAŁ z telefonu (pełna rozdzielczość), tylko przekodowany na JPEG (nie wielka bitmapa) —
//    żeby lokalnie widzieć dokładnie to, co zrobił aparat, i móc potem stroić rozmiary w LAB.
const MODEL_WIDTH = 2000;
const MODEL_QUALITY = 0.72;
const SAMPLE_QUALITY = 0.92;

/** Pomniejsza dowolny plik (np. hi-res sampel przy replayu) do rozmiaru DO MODELU → base64. */
export async function downscaleForModel(uri: string): Promise<string | null> {
  try {
    const ref = await ImageManipulator.manipulate(uri).resize({ width: MODEL_WIDTH }).renderAsync();
    const r = await ref.saveAsync({ compress: MODEL_QUALITY, format: SaveFormat.JPEG, base64: true });
    return r.base64 ?? null;
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

async function compress(uri: string, exif?: Record<string, unknown> | null): Promise<PreparedImage> {
  // STABILNY hash ŹRÓDŁA — md5 ORYGINAŁU (przed jakąkolwiek modyfikacją). Natywnie, synchronicznie.
  // Best-effort: gdy plik niedostępny → brak hasha → serwer po prostu nie cache'uje struktury tej fotki.
  let srcHash: string | undefined;
  try { srcHash = new File(uri).md5 ?? undefined; } catch { /* brak hasha = brak cache struktury */ }
  // DO MODELU — pomniejszone + base64.
  const modelRef = await ImageManipulator.manipulate(uri).resize({ width: MODEL_WIDTH }).renderAsync();
  const model = await modelRef.saveAsync({ compress: MODEL_QUALITY, format: SaveFormat.JPEG, base64: true });
  if (!model.base64) throw new Error("Nie udało się przygotować zdjęcia.");
  // DO SAMPLA — ORYGINAŁ (bez resize), tylko przekodowany na JPEG (nie wielka bitmapa). Tylko plik.
  let hiResUri: string | undefined;
  try {
    const hiRef = await ImageManipulator.manipulate(uri).renderAsync();
    hiResUri = (await hiRef.saveAsync({ compress: SAMPLE_QUALITY, format: SaveFormat.JPEG })).uri;
  } catch {
    /* best-effort — gdy padnie, sampel zapisze wersję modelu (fallback w persistImage) */
  }
  return {
    uri: model.uri,
    base64: model.base64,
    hiResUri,
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
  return compress(a.uri, a.exif);
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
  return Promise.all(res.assets.map((a) => compress(a.uri, a.exif)));
}
