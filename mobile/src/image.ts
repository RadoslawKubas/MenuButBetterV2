// Pobranie zdjęć (aparat / galeria — wiele naraz) + kompresja przed wysyłką.
// Czytamy też EXIF GPS (jeśli zdjęcie ma zaszyte współrzędne — np. zrobione na miejscu).
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { GeoPoint } from "./types";

export interface PreparedImage {
  uri: string; // skompresowany plik — do podglądu miniatury
  base64: string;
  mediaType: "image/jpeg";
  /** Współrzędne z EXIF zdjęcia, jeśli były zaszyte. */
  exifLocation?: GeoPoint;
}

const MAX_WIDTH = 1600; // wystarcza Claude do odczytu, a mocno tnie rozmiar
// Górny, rozsądny limit liczby zdjęć na jeden skan (duże menu robimy partiami).
export const MAX_IMAGES = 40;
// Ile zdjęć leci do modelu w jednym wywołaniu (≤ limit serwera = 10). Większe menu
// dzielimy na partie i scalamy wyniki z deduplikacją.
export const SCAN_BATCH = 8;

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
  const ref = await ImageManipulator.manipulate(uri).resize({ width: MAX_WIDTH }).renderAsync();
  const result = await ref.saveAsync({ compress: 0.6, format: SaveFormat.JPEG, base64: true });
  if (!result.base64) throw new Error("Nie udało się przygotować zdjęcia.");
  return {
    uri: result.uri,
    base64: result.base64,
    mediaType: "image/jpeg",
    exifLocation: exifToGeo(exif),
  };
}

/** Robi zdjęcie aparatem (jedno). Zwraca null, gdy użytkownik anuluje. */
export async function captureFromCamera(): Promise<PreparedImage | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Brak zgody na użycie aparatu.");
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1, exif: true });
  if (res.canceled || !res.assets[0]) return null;
  const a = res.assets[0];
  return compress(a.uri, a.exif);
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
