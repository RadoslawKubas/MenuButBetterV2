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
import { downscaleForModel, type PreparedImage } from "./image";
import { getInstallId } from "./api";
import { listScans, saveScan } from "./storage";
import { DEFAULT_MODELS, type GeoPoint, type LocationSource, type Menu, type ModelId, type ModelRole, type Usage } from "./types";

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
  /** Nazwa nadana przez użytkownika (do łatwego rozpoznania) — opcjonalna. */
  name?: string;
  // — Podpowiedzi przekazane modelowi (część WEJŚCIA, nie zależą od wyboru modelu) —
  // UWAGA: język i model NIE są tu trzymane celowo — „Wyślij ponownie" robi nowy skan wg
  // AKTUALNYCH ustawień, a język/modele użyte do WYNIKU są przy powiązanym skanie w historii.
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
  /** OSTATNI powiązany skan (back-compat + eksport bierze stąd WYNIK). */
  scanId?: string | null;
  /** WSZYSTKIE przebiegi tego wejścia (po jednym na każdy „Przetłumacz menu" z tej migawki)
   *  — hub porównań „to samo menu, różne modele". Najnowszy na końcu. */
  runs?: { scanId: string; at: number }[];
  /** Sygnatura WEJŚCIA (zdjęcia + podpowiedzi + lokalizacja) — do dedupu identycznych migawek. */
  sig?: string;
  /** Pochodzenie: "app" = powstała w apce (własny skan), "server" = zaciągnięta z serwera (z labu). */
  origin?: "app" | "server";
}

/** Zwraca przebiegi migawki (z fallbackiem do starego pojedynczego scanId). */
export function captureRuns(c: ScanCapture): { scanId: string; at: number }[] {
  if (c.runs && c.runs.length) return c.runs;
  return c.scanId ? [{ scanId: c.scanId, at: c.createdAt }] : [];
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Tani, mocny odcisk pojedynczego zdjęcia: długość base64 + kilka próbek znaków z ustalonych
// pozycji. Identyczny plik → identyczny odcisk; różne pliki praktycznie zawsze się różnią
// (bez liczenia pełnego hasza całego base64 przy każdym skanie).
function imgFingerprint(b64: string): string {
  const n = b64.length;
  if (n === 0) return "0";
  return `${n}:${b64[0]}${b64[Math.floor(n / 3)]}${b64[Math.floor(n / 2)]}${b64[n - 1]}`;
}

// Sygnatura całego WEJŚCIA migawki — żeby nie tworzyć identycznej migawki dwa razy.
// Modele/język NIE wchodzą (nie są częścią migawki) → to samo wejście różnymi modelami = 1 migawka.
function captureSig(input: {
  images: PreparedImage[];
  restaurantHint?: string;
  locationHint?: string;
  location: GeoPoint | null;
  locationSource: LocationSource;
  useExifLocation: boolean;
  useDeviceLocation: boolean;
}): string {
  // TOŻSAMOŚĆ MIGAWKI = SAME ZDJĘCIA. Hint lokalu, miasto, GPS, źródło i przełączniki NIE wchodzą w klucz:
  // hint/miasto nie są już ręcznie wpisywane (usunęliśmy „Opcje skanu" — robisz zdjęcia i skanujesz), GPS dryfuje
  // przy spacerze, a auto-hint z peeka bywa zmienny → każdy z nich tworzyłby nową migawkę tej samej karty.
  // Te same zdjęcia = ta sama migawka; pozycję/hint/miasto migawka i tak STORE'uje w danych (z PIERWSZEJ próby).
  const imgs = input.images.map((im) => imgFingerprint(im.base64 ?? "")).join(",");
  return [input.images.length, imgs].join("|");
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

// Zapisuje zdjęcie menu do katalogu migawek i zwraca referencję względną.
// SAMPEL = ORYGINAŁ VERBATIM z telefonu (hiResUri, kopiowany 1:1 bez przekodowania) — PEŁNA jakość, jak zapis
// do galerii. To NIE jest pomniejszona wersja do modelu (ta idzie osobno, dociela ją telefon). Dzięki temu
// md5(pliku)=srcHash, więc replay liczy ten sam klucz cache, a do modelu replay pomniejsza ten plik na nowo.
function tryCopyFile(srcUri: string, dest: File): boolean {
  try { new File(srcUri).copy(dest); return true; } catch { return false; }
}
function persistImage(captureId: string, idx: number, img: PreparedImage): CaptureImage {
  ensureDir();
  const name = `${captureId}-${idx}.jpg`;
  const dest = new File(DIR, name);
  if (dest.exists) dest.delete();
  // SAMPEL = najlepiej ORYGINAŁ VERBATIM (hiResUri, 1:1 → md5(pliku)=srcHash, replay trafia w cache).
  // UWAGA: `File.copy()` SAM tworzy plik docelowy — NIE wolno robić `dest.create()` przed copy, bo kopiowanie
  // na istniejący plik rzuca („destination exists") → hi-res nigdy się nie zapisywał, a `saveCapture` cicho
  // połykał błąd (migawka bez zdjęcia). Gdy hi-res nie wyjdzie (plik zniknął / EXIF) — NIE GUB zdjęcia:
  // zapisz pomniejszoną wersję DO MODELU (base64, zawsze w pamięci; `write` wymaga utworzonego pliku).
  if (img.hiResUri && tryCopyFile(img.hiResUri, dest)) {
    /* hi-res OK */
  } else if (img.base64) {
    if (img.hiResUri) console.warn(`[capture] hi-res niedostępny (${name}) → zapisuję pomniejszoną wersję z pamięci`);
    if (!dest.exists) dest.create();
    dest.write(img.base64, { encoding: "base64" });
  } else if (!tryCopyFile(img.uri, dest)) {
    throw new Error("brak źródła zdjęcia do zapisu migawki");
  }
  return { path: `captures/${name}`, mediaType: img.mediaType, exifLocation: img.exifLocation };
}

/** Stabilny srcHash zdjęcia migawki = md5 PLIKU sampla. Sampel to verbatim oryginał (image.ts), więc md5
 *  jest IDENTYCZNE z hashem liczonym przy świeżym skanie → replay trafia w ten sam cache struktury. Nie
 *  trzymamy hasha w metadanych — liczymy go z pliku (natywnie, File.md5). */
export function captureSrcHash(im: CaptureImage): string | undefined {
  try {
    const f = fileFor(im.path);
    return f?.exists ? (f.md5 ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/** Trwale zapisuje zdjęcia ŹRÓDŁOWE skanu (te, z których powstało menu) — do podglądu w historii.
 *  Reużywa tego samego katalogu/co migawki (resolveCaptureUri rozwiązuje ścieżkę). ownerId = scanId. */
export function persistScanImages(ownerId: string, images: PreparedImage[]): CaptureImage[] {
  const out: CaptureImage[] = [];
  images.forEach((img, i) => {
    try {
      out.push(persistImage(ownerId, i, img));
    } catch {
      // pojedynczy plik się nie zapisał — pomiń, reszta i tak się przyda
    }
  });
  return out;
}

/** Usuwa pliki zdjęć źródłowych skanu (przy kasowaniu skanu z historii) — sprzątanie miejsca. */
export function deleteScanImages(photos: { path: string }[]): void {
  for (const p of photos) {
    try {
      const f = fileFor(p.path);
      if (f?.exists) f.delete();
    } catch {
      // ignorujemy — best effort
    }
  }
}

export async function saveCapture(input: {
  images: PreparedImage[];
  restaurantHint?: string;
  locationHint?: string;
  location: GeoPoint | null;
  locationSource: LocationSource;
  useExifLocation: boolean;
  useDeviceLocation: boolean;
}): Promise<ScanCapture> {
  const sig = captureSig(input);
  const all = await listCaptures();
  // TE SAME ZDJĘCIA (+ hint/miasto) → nie duplikuj, zwróć istniejącą migawkę (caller podepnie nowy scanId,
  // więc wskazuje najświeższy wynik). Dzięki temu KOLEJNE PRÓBY tego samego menu (np. po nieudanym odczycie,
  // gdy GPS dryfuje bo idziesz) NIE tworzą nowych migawek — trafiają w tę samą, z PIERWSZĄ (najlepszą) pozycją.
  const dup = all.find((c) => c.sig && c.sig === sig);
  if (dup) return dup;

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
    restaurantHint: input.restaurantHint,
    locationHint: input.locationHint,
    location: input.location,
    locationSource: input.locationSource,
    useExifLocation: input.useExifLocation,
    useDeviceLocation: input.useDeviceLocation,
    images,
    sig,
    origin: "app", // własny skan w aplikacji
  };
  all.unshift(capture); // najnowsze na górze
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
  return capture;
}

/** Dopisuje PRZEBIEG (nowy skan z tego wejścia) do migawki — hub porównań. Najnowszy = scanId. */
export async function addCaptureRun(id: string, scanId: string): Promise<void> {
  const all = await listCaptures();
  const c = all.find((c) => c.id === id);
  if (!c) return;
  if (!c.runs) c.runs = c.scanId ? [{ scanId: c.scanId, at: c.createdAt }] : [];
  // Nie dubluj, jeśli ten sam skan jest już ostatni (np. podwójny zapis).
  if (c.runs[c.runs.length - 1]?.scanId !== scanId) c.runs.push({ scanId, at: Date.now() });
  c.scanId = scanId; // „ostatni" — do eksportu i back-compat
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

/** Nadaje migawce nazwę (pusta = usuwa nazwę). */
export async function renameCapture(id: string, name: string): Promise<void> {
  const all = await listCaptures();
  const c = all.find((c) => c.id === id);
  if (!c) return;
  c.name = name.trim() || undefined;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

/** Kasuje WSZYSTKIE migawki + ich pliki zdjęć (porządki). */
export async function deleteAllCaptures(): Promise<void> {
  const all = await listCaptures();
  for (const cap of all) {
    for (const im of cap.images) {
      try {
        const f = fileFor(im.path);
        if (f?.exists) f.delete();
      } catch {
        /* plik mógł już zniknąć */
      }
    }
  }
  await AsyncStorage.setItem(KEY, JSON.stringify([]));
}

/** Suma rozmiaru zdjęć migawek na dysku (bajty) — do informacji o zajętym miejscu. */
export function capturesDiskBytes(captures: ScanCapture[]): number {
  let total = 0;
  for (const c of captures) {
    for (const im of c.images) {
      try {
        const f = fileFor(im.path);
        if (f?.exists) total += f.size ?? 0;
      } catch {
        /* pomiń niedostępny plik */
      }
    }
  }
  return total;
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

/** Odczytuje zapisane zdjęcie do ponownego wysłania (replay). Sampel jest HI-RES → pomniejszamy do
 *  rozmiaru modelu (jak przy świeżym skanie), żeby payload był taki sam. Fallback: surowy base64. */
export async function captureImageBase64(im: CaptureImage): Promise<string | null> {
  try {
    const f = fileFor(im.path);
    if (!f?.exists) return null;
    return (await downscaleForModel(f.uri)) ?? (await f.base64());
  } catch {
    return null;
  }
}

/** Wpis w `metadata.json` archiwum — zdjęcia jako osobne pliki w `images/`. */
export interface CaptureExportEntry extends Omit<ScanCapture, "images"> {
  /** GUID instancji apki, z której pochodzi eksport — lab rozpoznaje źródło migawki z pliku. */
  installId?: string;
  images: { file: string; mediaType: string; exifLocation?: GeoPoint }[];
  /** WYNIK skanu (z historii): ustawienia użyte do WYNIKU + przetłumaczone menu + lokal + koszt. */
  result?: {
    targetLang?: string;
    models?: Record<ModelRole, ModelId>;
    model?: ModelId;
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
          targetLang: scan.targetLang,
          models: scan.models,
          model: scan.model,
          restaurantName: scan.menu.restaurant_name,
          cuisine: scan.menu.cuisine,
          restaurant: scan.restaurant ?? undefined,
          usage: scan.usage,
          menu: scan.menu,
        }
      : undefined;
    entries.push({ ...meta, images, result, installId: getInstallId() });
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

/**
 * Buduje paczkę do WYSYŁKI ONLINE jednej migawki: zip (base64, ten sam format co eksport →
 * lab importuje istniejącym ingestem), hash = stabilna sygnatura migawki, meta = podsumowanie do
 * listy w labie. Zwraca null, gdy migawki nie ma. Wysyłkę robi api.uploadSample.
 */
export async function buildCaptureUpload(captureId: string): Promise<{ hash: string; meta: Record<string, unknown>; zipBase64: string } | null> {
  const all = await listCaptures();
  const c = all.find((x) => x.id === captureId);
  if (!c) return null;
  const scans = await listScans().catch(() => []);
  const scan = c.scanId ? scans.find((s) => s.id === c.scanId) : undefined;

  const zip = new JSZip();
  const imagesDir = zip.folder("images")!;
  const images: CaptureExportEntry["images"] = [];
  for (let i = 0; i < c.images.length; i++) {
    const im = c.images[i]!;
    const base64 = await captureImageBase64(im);
    if (!base64) continue;
    imagesDir.file(`${c.id}-${i}.jpg`, base64, { base64: true });
    images.push({ file: `images/${c.id}-${i}.jpg`, mediaType: im.mediaType, exifLocation: im.exifLocation });
  }
  const { images: _drop, ...metaCap } = c;
  const result: CaptureExportEntry["result"] = scan
    ? { targetLang: scan.targetLang, models: scan.models, model: scan.model, restaurantName: scan.menu.restaurant_name, cuisine: scan.menu.cuisine, restaurant: scan.restaurant ?? undefined, usage: scan.usage, menu: scan.menu }
    : undefined;
  const entries: CaptureExportEntry[] = [{ ...metaCap, images, result, installId: getInstallId() }];
  zip.file("metadata.json", JSON.stringify({ format: "menubutbetter.captures", version: 1, exportedAt: Date.now(), count: 1, captures: entries }, null, 2));
  const zipBase64 = await zip.generateAsync({ type: "base64", compression: "STORE" });

  const meta = { name: c.name ?? null, images: images.length, restaurantHint: c.restaurantHint ?? null, locationHint: c.locationHint ?? null, createdAt: c.createdAt };
  return { hash: c.sig || c.id, meta, zipBase64 };
}

/**
 * Import migawek z ZIP-a (z serwera / labu) do lokalnej biblioteki. Format = eksportowy
 * (metadata.json + images/). Dedup po `sig`: gdy migawka o tym sig już jest → AKTUALIZUJ
 * (podmień wynik/przebieg, nie twórz nowej). Gdy entry ma `result.menu` → odtwórz skan w historii,
 * żeby migawka pokazała menu. Zwraca ile dodano/zaktualizowano.
 */
export async function importCapturesFromZip(data: Uint8Array): Promise<{ added: number; updated: number }> {
  const zip = await JSZip.loadAsync(data);
  const metaFile = zip.file("metadata.json");
  if (!metaFile) throw new Error("ZIP bez metadata.json");
  const caps = (JSON.parse(await metaFile.async("string")).captures ?? []) as CaptureExportEntry[];
  const all = await listCaptures();
  let added = 0, updated = 0;
  for (const entry of caps) {
    const sig = entry.sig;
    const existing = sig ? all.find((c) => c.sig === sig) : undefined;
    // Odtwórz skan z zapisanego wyniku (gdy jest) → migawka od razu pokaże menu.
    let scanId: string | null = existing?.scanId ?? null;
    if (entry.result?.menu) {
      const saved = await saveScan({
        menu: entry.result.menu as Menu,
        targetLang: entry.result.targetLang ?? "polski",
        model: (entry.result.model ?? DEFAULT_MODELS.scan) as ModelId,
        models: entry.result.models,
        location: entry.location ?? null,
        locationSource: entry.locationSource ?? null,
        useExifLocation: entry.useExifLocation,
        useDeviceLocation: entry.useDeviceLocation,
        usage: entry.result.usage as Usage | undefined,
      }).catch(() => null);
      if (saved) scanId = saved.id;
    }
    if (existing) {
      if (scanId && scanId !== existing.scanId) {
        existing.runs = existing.runs ?? (existing.scanId ? [{ scanId: existing.scanId, at: existing.createdAt }] : []);
        existing.runs.push({ scanId, at: Date.now() });
        existing.scanId = scanId;
      }
      if (entry.name) existing.name = entry.name;
      if (entry.restaurantHint) existing.restaurantHint = entry.restaurantHint;
      if (entry.locationHint) existing.locationHint = entry.locationHint;
      updated++;
      continue;
    }
    // Nowa migawka: wypakuj zdjęcia z zipa na dysk.
    const id = newId();
    const images: CaptureImage[] = [];
    const list = entry.images ?? [];
    for (let i = 0; i < list.length; i++) {
      const im = list[i]!;
      const base = im.file.split("/").pop()!;
      const f = zip.file(`images/${base}`) ?? zip.file(im.file);
      if (!f) continue;
      const b64 = await f.async("base64");
      ensureDir();
      const name = `${id}-${i}.jpg`;
      const dest = new File(DIR, name);
      if (dest.exists) dest.delete();
      dest.create();
      dest.write(b64, { encoding: "base64" });
      images.push({ path: `captures/${name}`, mediaType: "image/jpeg", exifLocation: im.exifLocation });
    }
    if (!images.length) continue;
    all.unshift({
      id,
      createdAt: entry.createdAt ?? Date.now(),
      name: entry.name,
      restaurantHint: entry.restaurantHint,
      locationHint: entry.locationHint,
      location: entry.location ?? null,
      locationSource: entry.locationSource ?? null,
      useExifLocation: entry.useExifLocation ?? true,
      useDeviceLocation: entry.useDeviceLocation ?? true,
      images,
      sig,
      origin: "server", // zaciągnięta z serwera (z labu)
      scanId: scanId ?? undefined,
      runs: scanId ? [{ scanId, at: Date.now() }] : undefined,
    });
    added++;
  }
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
  return { added, updated };
}
