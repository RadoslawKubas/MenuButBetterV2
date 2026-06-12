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
  type RestaurantInfo,
  type Usage,
} from "./types";

export type { GeoPoint } from "./types";

export interface SavedScan {
  id: string;
  createdAt: number; // epoch ms
  restaurantName: string | null;
  targetLang: string;
  model: ModelId;
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
}

const KEY = "mbb.scans.v1";

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
  location: GeoPoint | null;
  locationSource: LocationSource;
  useExifLocation?: boolean;
  useDeviceLocation?: boolean;
  usage?: Usage;
}): Promise<SavedScan> {
  const scan: SavedScan = {
    id: newId(),
    createdAt: Date.now(),
    restaurantName: input.menu.restaurant_name,
    targetLang: input.targetLang,
    model: input.model,
    menu: input.menu,
    location: input.location,
    locationSource: input.locationSource,
    useExifLocation: input.useExifLocation,
    useDeviceLocation: input.useDeviceLocation,
    usage: input.usage ?? ZERO_USAGE,
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
