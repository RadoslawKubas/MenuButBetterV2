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
const PREF_MODELS_KEY = "mbb.pref.models.v1";

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Wybór modelu PER miejsce użycia (skan / opisy / weryfikacja / venue) — zapamiętany. */
export async function loadModelPrefs(): Promise<Partial<Record<ModelRole, ModelId>>> {
  const raw = await AsyncStorage.getItem(PREF_MODELS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<Record<ModelRole, ModelId>>;
  } catch {
    return {};
  }
}

export async function saveModelPrefs(models: Record<ModelRole, ModelId>): Promise<void> {
  await AsyncStorage.setItem(PREF_MODELS_KEY, JSON.stringify(models));
}

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

const PREF_COST_KEY = "mbb.pref.cost.v1";

/** Kontrola AUTOMATYCZNEGO (masowego) kosztu po skanie. „Na dotknięcie" działa zawsze. */
export interface CostPrefs {
  /** Auto-generowanie rozszerzonych opisów dla wszystkich dań po skanie. */
  autoDescriptions: boolean;
  /** Auto-dociąganie zdjęć poglądowych dla wszystkich dań po skanie. */
  autoPhotos: boolean;
  /** Auto-dopasowanie zdjęć z lokalu (Tier 0) po namierzeniu lokalu. */
  autoVenuePhotos: boolean;
  /** Limit dań objętych auto-dociąganiem (0 = wszystkie). Reszta tylko na dotknięcie. */
  autoLimit: number;
  /** „Bierz wszystko": pokazuj też zdjęcia ODRZUCONE (słaba jakość), oznaczone, posortowane.
   *  Domyślnie OFF (apka bierze tylko najlepsze). Włącz, by zobaczyć, co realnie wpada. */
  takeAllPhotos: boolean;
}

export const DEFAULT_COST_PREFS: CostPrefs = {
  autoDescriptions: true,
  autoPhotos: true,
  autoVenuePhotos: true,
  autoLimit: 0,
  takeAllPhotos: false, // domyślnie tylko najlepsze; włącz, by widzieć też odrzucone
};

export async function loadCostPrefs(): Promise<CostPrefs> {
  const raw = await AsyncStorage.getItem(PREF_COST_KEY);
  if (!raw) return DEFAULT_COST_PREFS;
  try {
    return { ...DEFAULT_COST_PREFS, ...(JSON.parse(raw) as Partial<CostPrefs>) };
  } catch {
    return DEFAULT_COST_PREFS;
  }
}

export async function saveCostPrefs(prefs: CostPrefs): Promise<void> {
  await AsyncStorage.setItem(PREF_COST_KEY, JSON.stringify(prefs));
}

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
}

export async function deleteScan(id: string): Promise<void> {
  const all = (await listScans()).filter((s) => s.id !== id);
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

/** Zapisuje rozszerzony opis i/lub zdjęcia dania w zapisanym skanie. */
export async function updateScanItem(
  id: string,
  sectionIndex: number,
  itemIndex: number,
  patch: { extraInfo?: string; photos?: DishPhotoLite[]; photosUpgraded?: boolean },
): Promise<void> {
  const all = await listScans();
  const scan = all.find((s) => s.id === id);
  const item = scan?.menu.sections[sectionIndex]?.items[itemIndex];
  if (!item) return;
  if (patch.extraInfo !== undefined) item.extraInfo = patch.extraInfo;
  if (patch.photos !== undefined) item.photos = patch.photos;
  if (patch.photosUpgraded !== undefined) item.photosUpgraded = patch.photosUpgraded;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

/** Podmienia całe menu w zapisanym skanie (np. po dociągnięciu zdjęć w tle). */
export async function updateScanMenu(id: string, menu: Menu): Promise<void> {
  const all = await listScans();
  const scan = all.find((s) => s.id === id);
  if (!scan) return;
  scan.menu = menu;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

/** Nadaje trwały sessionId zapisanemu skanowi (dla starych skanów bez sesji) — by oglądanie/dorabianie
 *  trzymało się jednej sesji zamiast tworzyć „widmowe" przy każdym otwarciu. */
export async function setScanSessionId(id: string, sessionId: string): Promise<void> {
  const all = await listScans();
  const scan = all.find((s) => s.id === id);
  if (!scan || scan.sessionId) return; // nie nadpisuj istniejącej sesji
  scan.sessionId = sessionId;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

export async function setScanSourcePhotos(id: string, photos: { path: string; mediaType: string }[]): Promise<void> {
  const all = await listScans();
  const scan = all.find((s) => s.id === id);
  if (!scan) return;
  scan.sourcePhotos = photos;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

/** Zmienia nazwę, pod jaką zapisane jest menu (tytuł w historii + nagłówek menu). */
export async function renameScan(id: string, name: string): Promise<void> {
  const all = await listScans();
  const scan = all.find((s) => s.id === id);
  if (!scan) return;
  const trimmed = name.trim() || null;
  scan.restaurantName = trimmed;
  scan.menu.restaurant_name = trimmed;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

/** Usuwa dopasowany lokal (Google Places) ze skanu — karta lokalu znika. */
export async function clearScanRestaurant(id: string): Promise<void> {
  const all = await listScans();
  const scan = all.find((s) => s.id === id);
  if (!scan) return;
  delete scan.restaurant;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

/** Dolicza zużycie (tokeny + koszt) do zapisanego skanu i zwraca nową sumę. */
export async function addScanUsage(id: string, delta: Usage): Promise<Usage | null> {
  const all = await listScans();
  const scan = all.find((s) => s.id === id);
  if (!scan) return null;
  scan.usage = addUsage(scan.usage ?? ZERO_USAGE, delta);
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
  return scan.usage;
}

/** Zapisuje dane lokalu (Google Places) w zapisanym skanie. */
export async function updateScanRestaurant(id: string, restaurant: RestaurantInfo): Promise<void> {
  const all = await listScans();
  const scan = all.find((s) => s.id === id);
  if (!scan) return;
  scan.restaurant = restaurant;
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}
