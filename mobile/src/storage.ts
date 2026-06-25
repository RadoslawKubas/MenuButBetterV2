// Lokalny zapis przetłumaczonych menu (historia) — AsyncStorage.
// Trzymamy sam JSON menu + metadane (bez zdjęć, żeby nie rozdmuchać pamięci).
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ZERO_USAGE,
  addUsage,
  type DishPhotoLite,
  type GeoPoint,
  type LocationSource,
  type Menu,
  type ModelId,
  type ModelRole,
  type RestaurantInfo,
  type Usage,
} from "./types";

export type { GeoPoint } from "./types";

export interface SavedScan {
  id: string;
  createdAt: number; // epoch ms
  restaurantName: string | null;
  targetLang: string;
  /** Model SKANU (back-compat; pełny zestaw per rola jest w `models`). */
  model: ModelId;
  /** Zamrożony zestaw modeli per rola, którymi zrobiono to menu (skan/opisy/weryfikacja/venue).
   *  Opcjonalny — starsze skany go nie mają (wtedy w UI używamy bieżących ustawień). */
  models?: Record<ModelRole, ModelId>;
  menu: Menu;
  /** Lokalizacja powiązana ze skanem (z GPS użytkownika lub EXIF zdjęcia). */
  location: GeoPoint | null;
  locationSource: LocationSource;
  /** Ustawienia lokalizacji w chwili skanu — co user miał włączone (do zapamiętania). */
  useExifLocation?: boolean;
  useDeviceLocation?: boolean;
  /** Dane lokalu z Google Places — dociągane i cache'owane. */
  restaurant?: RestaurantInfo | null;
  /** Łączny koszt tego skanu (skan + weryfikacje zdjęć + opisy). */
  usage?: Usage;
  /** Zdjęcia ŹRÓDŁOWE skanu (te, z których powstało menu) — do podglądu w historii (resolveCaptureUri). */
  sourcePhotos?: { path: string; mediaType: string }[];
  /** ID SESJI usera (od „nowy skan" do „nowy skan"). Po otwarciu z historii i dorabianiu wracamy do niej
   *  (te same ops tagujemy tym sessionId) → statystyki grupują całość jednego menu razem, a koniec sesji
   *  przesuwa się na ostatnią akcję. */
  sessionId?: string;
}

const KEY = "mbb.scans.v1";

// Wszystkie mutacje listy skanów to read-modify-write na JEDNEJ tablicy w AsyncStorage. Bez serializacji
// równoległe (fire-and-forget) zapisy — np. po `done`: updateScanMenu + addScanUsage, albo updateScanRestaurant
// z onVenue — czytają tę samą tablicę i NADPISUJĄ się nawzajem (ginie lokal albo menu ze zdjęciami). Łańcuch
// poniżej wymusza, że każdy read-modify-write wykona się ATOMOWO względem innych (kolejka po jednym).
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn); // odpal po poprzednim (niezależnie czy się udał)
  writeChain = run.then(() => {}, () => {}); // utrzymaj łańcuch, połknij błędy
  return run;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// (Wybór modeli PER etap przeniesiony na serwer — config runtime edytowany w LAB. Kod ustawień modeli w
//  apce usunięty; modele nadpisuje serwer.)

const PREF_LANG_KEY = "mbb.pref.lang.v1";

/** Domyślny język tłumaczenia (ustawiany w Ustawieniach) — zapamiętany. */
export async function loadLangPref(): Promise<string | null> {
  return (await AsyncStorage.getItem(PREF_LANG_KEY)) || null;
}

export async function saveLangPref(lang: string): Promise<void> {
  await AsyncStorage.setItem(PREF_LANG_KEY, lang);
}

const PREF_HISTGROUP_KEY = "mbb.pref.histgroup.v1";
export type HistoryGrouping = "city" | "date";

/** Tryb listy historii: grupowanie po mieście albo płasko po dacie (zapamiętany). */
export async function loadHistoryGrouping(): Promise<HistoryGrouping | null> {
  const v = await AsyncStorage.getItem(PREF_HISTGROUP_KEY);
  return v === "city" || v === "date" ? v : null;
}

export async function saveHistoryGrouping(v: HistoryGrouping): Promise<void> {
  await AsyncStorage.setItem(PREF_HISTGROUP_KEY, v);
}

const PREF_SERIALCAM_KEY = "mbb.pref.serialcam.v1";

/** Tryb seryjny aparatu (wiele zdjęć bez zamykania) — zapamiętany. Domyślnie wyłączony. */
export async function loadSerialCamPref(): Promise<boolean> {
  return (await AsyncStorage.getItem(PREF_SERIALCAM_KEY)) === "1";
}

export async function saveSerialCamPref(on: boolean): Promise<void> {
  await AsyncStorage.setItem(PREF_SERIALCAM_KEY, on ? "1" : "0");
}

const PREF_PEEK_KEY = "mbb.pref.peek.v1";

/** „Szybki podgląd" w aparacie (na żywo kuchnia/nazwa) — zapamiętany. Domyślnie włączony. */
export async function loadPeekPref(): Promise<boolean> {
  const v = await AsyncStorage.getItem(PREF_PEEK_KEY);
  return v === null ? true : v === "1"; // domyślnie wł.
}

export async function savePeekPref(on: boolean): Promise<void> {
  await AsyncStorage.setItem(PREF_PEEK_KEY, on ? "1" : "0");
}

// (Kontrola auto-dociągania po skanie — dawne CostPrefs — przeniesiona na serwer: config runtime czytany
//  przez apkę z /app-config (autoDescriptions, autoLimit) + toggle'e źródeł/weryfikacji w LAB.)

export async function listScans(): Promise<SavedScan[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as SavedScan[];
  } catch {
    return [];
  }
}

export async function saveScan(input: {
  menu: Menu;
  targetLang: string;
  model: ModelId;
  models?: Record<ModelRole, ModelId>;
  location: GeoPoint | null;
  locationSource: LocationSource;
  useExifLocation?: boolean;
  useDeviceLocation?: boolean;
  usage?: Usage;
  sessionId?: string;
}): Promise<SavedScan> {
  return serialize(async () => {
    const scan: SavedScan = {
      id: newId(),
      createdAt: Date.now(),
      restaurantName: input.menu.restaurant_name,
      targetLang: input.targetLang,
      model: input.model,
      models: input.models,
      menu: input.menu,
      location: input.location,
      locationSource: input.locationSource,
      useExifLocation: input.useExifLocation,
      useDeviceLocation: input.useDeviceLocation,
      usage: input.usage ?? ZERO_USAGE,
      sessionId: input.sessionId,
    };
    const all = await listScans();
    all.unshift(scan); // najnowsze na górze
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
    return scan;
  });
}

export async function deleteScan(id: string): Promise<void> {
  return serialize(async () => {
    const all = (await listScans()).filter((s) => s.id !== id);
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  });
}

/** Zapisuje rozszerzony opis i/lub zdjęcia dania w zapisanym skanie. */
export async function updateScanItem(
  id: string,
  sectionIndex: number,
  itemIndex: number,
  patch: { extraInfo?: string; photos?: DishPhotoLite[]; photosUpgraded?: boolean },
): Promise<void> {
  return serialize(async () => {
    const all = await listScans();
    const scan = all.find((s) => s.id === id);
    const item = scan?.menu.sections[sectionIndex]?.items[itemIndex];
    if (!item) return;
    if (patch.extraInfo !== undefined) item.extraInfo = patch.extraInfo;
    if (patch.photos !== undefined) item.photos = patch.photos;
    if (patch.photosUpgraded !== undefined) item.photosUpgraded = patch.photosUpgraded;
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  });
}

/** Podmienia całe menu w zapisanym skanie (np. po dociągnięciu zdjęć w tle). */
export async function updateScanMenu(id: string, menu: Menu): Promise<void> {
  return serialize(async () => {
    const all = await listScans();
    const scan = all.find((s) => s.id === id);
    if (!scan) return;
    scan.menu = menu;
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  });
}

/** Nadaje trwały sessionId zapisanemu skanowi (dla starych skanów bez sesji) — by oglądanie/dorabianie
 *  trzymało się jednej sesji zamiast tworzyć „widmowe" przy każdym otwarciu. */
export async function setScanSessionId(id: string, sessionId: string): Promise<void> {
  return serialize(async () => {
    const all = await listScans();
    const scan = all.find((s) => s.id === id);
    if (!scan || scan.sessionId) return; // nie nadpisuj istniejącej sesji
    scan.sessionId = sessionId;
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  });
}

export async function setScanSourcePhotos(id: string, photos: { path: string; mediaType: string }[]): Promise<void> {
  return serialize(async () => {
    const all = await listScans();
    const scan = all.find((s) => s.id === id);
    if (!scan) return;
    scan.sourcePhotos = photos;
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  });
}

/** Zmienia nazwę, pod jaką zapisane jest menu (tytuł w historii + nagłówek menu). */
export async function renameScan(id: string, name: string): Promise<void> {
  return serialize(async () => {
    const all = await listScans();
    const scan = all.find((s) => s.id === id);
    if (!scan) return;
    const trimmed = name.trim() || null;
    scan.restaurantName = trimmed;
    scan.menu.restaurant_name = trimmed;
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  });
}

/** Usuwa dopasowany lokal (Google Places) ze skanu — karta lokalu znika. */
export async function clearScanRestaurant(id: string): Promise<void> {
  return serialize(async () => {
    const all = await listScans();
    const scan = all.find((s) => s.id === id);
    if (!scan) return;
    delete scan.restaurant;
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  });
}

/** Dolicza zużycie (tokeny + koszt) do zapisanego skanu i zwraca nową sumę. */
export async function addScanUsage(id: string, delta: Usage): Promise<Usage | null> {
  return serialize(async () => {
    const all = await listScans();
    const scan = all.find((s) => s.id === id);
    if (!scan) return null;
    scan.usage = addUsage(scan.usage ?? ZERO_USAGE, delta);
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
    return scan.usage;
  });
}

/** Ustawia koszt skanu na AUTORYTATYWNY total sesji z serwera (nagłówek x-session-cost) — monotonicznie
 *  (koszt sesji tylko rośnie). Łapie WSZYSTKO (też nie-AI: Serper/Places/proxy zdjęć), czego częściowa
 *  suma addScanUsage po stronie apki nie obejmowała → historia pokazuje realny koszt. Tokeny zostają. */
export async function setScanCost(id: string, costUsd: number): Promise<boolean> {
  return serialize(async () => {
    const all = await listScans();
    const scan = all.find((s) => s.id === id);
    if (!scan) return false;
    const cur = scan.usage ?? ZERO_USAGE;
    if (costUsd <= (cur.costUsd ?? 0)) return false; // monotoniczne — nie cofaj
    scan.usage = { ...cur, costUsd };
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
    return true;
  });
}

/** Zapisuje dane lokalu (Google Places) w zapisanym skanie. */
export async function updateScanRestaurant(id: string, restaurant: RestaurantInfo): Promise<void> {
  return serialize(async () => {
    const all = await listScans();
    const scan = all.find((s) => s.id === id);
    if (!scan) return;
    scan.restaurant = restaurant;
    await AsyncStorage.setItem(KEY, JSON.stringify(all));
  });
}
