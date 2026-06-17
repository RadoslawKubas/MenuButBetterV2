// Pozycja GPS urządzenia — używana TYLKO gdy użytkownik świadomie włączy
// „jestem teraz w tej restauracji". Nigdy domyślnie.
import * as Location from "expo-location";
import type { GeoPoint } from "./types";

export async function getCurrentLocation(): Promise<GeoPoint> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (!perm.granted) throw new Error("Brak zgody na dostęp do lokalizacji.");
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { lat: pos.coords.latitude, lng: pos.coords.longitude };
}

/** Odległość w metrach między dwoma punktami (haversine) — do grupy „w pobliżu". */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Zamienia współrzędne na „Miasto, Kraj" (na telefonie, bez klucza). Best-effort. */
export async function reverseGeocode(geo: GeoPoint): Promise<string | undefined> {
  try {
    const res = await Location.reverseGeocodeAsync({ latitude: geo.lat, longitude: geo.lng });
    const r = res[0];
    if (!r) return undefined;
    const city = r.city ?? r.subregion ?? r.region ?? undefined;
    return [city, r.country].filter(Boolean).join(", ") || undefined;
  } catch {
    return undefined;
  }
}
