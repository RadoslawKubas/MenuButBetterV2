// Tryb testowy: lokalny zapis „migawek skanu" — dokładnie tego, co poszło do serwera
// przy danym skanie (zdjęcia menu + ustawienia + pozycja GPS + locationHint). Pozwala
// później OTWORZYĆ listę zapisanych zestawów i WYSŁAĆ je ponownie, żeby od zera
// wygenerować nowy skan na identycznych danych (debug/porównania).
//
// Zdjęcia menu kopiujemy na dysk (katalog document → trwały) i trzymamy ścieżkę WZGLĘDNĄ
// ("captures/<plik>"); bezwzględny file:// składamy dopiero przy renderze/odczycie, bo
// bazowy katalog kontenera iOS zmienia się między uruchomieniami (jak w imageCache.ts).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Directory, File, Paths } from "expo-file-system";
import JSZip from "jszip";
import type { PreparedImage } from "./image";
import { listScans } from "./storage";
import type { GeoPoint, LocationSource, ModelId } from "./types";

const DIR = new Directory(Paths.document, "captures");
const KEY = "mbb.captures.v1";

function ensureDir(): void {
  if (!DIR.exists) DIR.create({ intermediates: true, idempotent: true });
}

/** Zapisany na dysk obraz menu wchodzący w skład migawki. */
export interface CaptureImage {
  /** Ścieżka WZGLĘDNA: "captures/<id>-<n>.jpg". */
  path: string;
  mediaType: "image/jpeg";
  /** Współrzędne z EXIF tego zdjęcia (jeśli były) — kontekst, co dało lokalizację. */
  exifLocation?: GeoPoint;
}

/** Migawka jednego skanu — komplet danych potrzebny do ponownego wysłania. */
export interface ScanCapture {
  id: string;
  createdAt: number; // epoch ms
  // — Ustawienia użyte do zapytania —
  targetLang: string;
  model: ModelId;
  restaurantHint?: string;
  /** „Miasto, Kraj" przekazane modelowi (z reverseGeocode). */
  locationHint?: string;
  // — Lokalizacja, która FAKTYCZNIE poszła ze skanem —
  location: GeoPoint | null;
  locationSource: LocationSource;
  useExifLocation: boolean;
  useDeviceLocation: boolean;
  // — Zdjęcia menu (wejście do modelu) —
  images: CaptureImage[];
  /** Powiązany skan w historii — przez niego dołączamy WYNIK przy eksporcie. */
  scanId?: string | null;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function listCaptures(): Promise<ScanCapture[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ScanCapture[];
  } catch {
    return [];
  }
}

// Kopiuje plik zdjęcia menu do katalogu migawek i zwraca referencję względną.
function persistImage(captureId: string, idx: number, img: PreparedImage): CaptureImage {
  ensureDir();
  const name = `${captureId}-${idx}.jpg`;
  const dest = new File(DIR, name);
  if (dest.exists) dest.delete();
  new File(img.uri).copy(dest);
  return { path: `captures/${name}`, mediaType: img.mediaType, exifLocation: img.exifLocation };
}

export async function saveCapture(input: {
  images: PreparedImage[];
  targetLang: string;
  model: ModelId;
  restaurantHint?: string;
  locationHint?: string;
  location: GeoPoint | null;
  locationSource: LocationSource;
  useExifLocation: boolean;
  useDeviceLocation: boolean;
}): Promise<ScanCapture> {
  const id = newId();
  const images: CaptureImage[] = [];
  input.images.forEach((img, i) => {
    try {
      images.push(persistImage(id, i, img));
    } catch {
      // nie udało się skopiować pojedynczego pliku — pomiń, reszta migawki i tak się przyda
    }
  });
  const capture: ScanCapture = {
    id,
    createdAt: Date.now(),
    targetLang: input.targetLang,
    model: input.model,
    restaurantHint: input.restaurantHint,
    locationHint: input.locationHint,
    location: input.location,
    locationSource: input.locationSource,
    useExifLocation: input.useExifLocation,
    useDeviceLocation: input.useDeviceLocation,
    images,
  };
  const all = await listCaptures();
  all.unshift(capture); // najnowsze na górze
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
  return capture;
}

/** Łączy migawkę z zapisanym skanem — przez niego eksport dołącza WYNIK skanu. */
export async function updateCaptureScanId(id: string, scanId: string): Promise<void> {
  const all = await listCaptures();
  const c = all.find((c) => c.id === id);
  if (!c) return;
  c.scanId = scanId;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

export async function deleteCapture(id: string): Promise<void> {
  const all = await listCaptures();
  const cap = all.find((c) => c.id === id);
  if (cap) {
    for (const im of cap.images) {
      try {
        const f = fileFor(im.path);
        if (f?.exists) f.delete();
      } catch {
        // plik mógł już zniknąć — ignoruj
      }
    }
  }
  await AsyncStorage.setItem(KEY, JSON.stringify(all.filter((c) => c.id !== id)));
}

// Składa obiekt File z zapisanej ścieżki względnej ("captures/<plik>").
function fileFor(path: string): File | null {
  const m = path.match(/captures\/([^/?#]+)$/);
  return m ? new File(DIR, m[1]!) : null;
}

/** Bezwzględny file:// URI zdjęcia migawki — do miniatur (składany przy renderze). */
export function resolveCaptureUri(path: string): string | undefined {
  return fileFor(path)?.uri ?? path;
}

/** Odczytuje zapisane zdjęcie jako base64 — do ponownego wysłania na serwer (replay). */
export async function captureImageBase64(im: CaptureImage): Promise<string | null> {
  try {
    const f = fileFor(im.path);
    if (!f?.exists) return null;
    return await f.base64();
  } catch {
    return null;
  }
}

/** Wpis w `metadata.json` archiwum — zdjęcia jako osobne pliki w `images/`. */
export interface CaptureExportEntry extends Omit<ScanCapture, "images"> {
  images: { file: string; mediaType: string; exifLocation?: GeoPoint }[];
  /** WYNIK skanu (z historii): przetłumaczone menu + dopasowany lokal + koszt. */
  result?: {
    restaurantName: string | null;
    cuisine?: string;
    restaurant?: unknown;
    usage?: unknown;
    menu: unknown;
  };
}

/**
 * Eksportuje WSZYSTKIE migawki do jednego pliku ZIP i zwraca jego file:// URI:
 *   - images/<id>-<n>.jpg  — surowe zdjęcia menu (gotowe do obejrzenia po rozpakowaniu),
 *   - metadata.json        — ustawienia + pozycja GPS każdej migawki (odwołania do plików).
 * Mniejszy i czytelniejszy niż base64 inline. Plik trafia do cache, gotowy do
 * udostępnienia. Zwraca null, gdy brak migawek.
 */
export async function exportCaptures(ids?: string[]): Promise<string | null> {
  const all = await listCaptures();
  const captures = ids && ids.length ? all.filter((c) => ids.includes(c.id)) : all;
  if (captures.length === 0) return null;

  // Wyniki skanów (z historii) — dołączamy je po scanId, żeby w eksporcie było widać
  // co model zwrócił (do analizy „co poszło nie tak").
  const scans = await listScans().catch(() => []);
  const scanById = new Map(scans.map((s) => [s.id, s]));

  const zip = new JSZip();
  const imagesDir = zip.folder("images")!;
  const entries: CaptureExportEntry[] = [];

  for (const c of captures) {
    const images: CaptureExportEntry["images"] = [];
    for (let i = 0; i < c.images.length; i++) {
      const im = c.images[i]!;
      const base64 = await captureImageBase64(im);
      if (!base64) continue;
      const fname = `${c.id}-${i}.jpg`;
      imagesDir.file(fname, base64, { base64: true });
      images.push({ file: `images/${fname}`, mediaType: im.mediaType, exifLocation: im.exifLocation });
    }
    const { images: _drop, ...meta } = c;
    const scan = c.scanId ? scanById.get(c.scanId) : undefined;
    const result: CaptureExportEntry["result"] = scan
      ? {
          restaurantName: scan.menu.restaurant_name,
          cuisine: scan.menu.cuisine,
          restaurant: scan.restaurant ?? undefined,
          usage: scan.usage,
          menu: scan.menu,
        }
      : undefined;
    entries.push({ ...meta, images, result });
  }

  zip.file(
    "metadata.json",
    JSON.stringify(
      { format: "menubutbetter.captures", version: 1, exportedAt: Date.now(), count: entries.length, captures: entries },
      null,
      2,
    ),
  );

  // JPEG już skompresowany → STORE (bez deflate): szybciej, rozmiar i tak ten sam.
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const prefix = captures.length === 1 ? "mbb-capture" : "mbb-captures";
  const file = new File(Paths.cache, `${prefix}-${stamp}.zip`);
  if (file.exists) file.delete();
  file.create();
  await file.write(bytes);
  return file.uri;
}
