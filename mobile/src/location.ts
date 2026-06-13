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
