// Osobny ekran WYSZUKIWANIA LOKALU (gdy auto-dopasowanie trafiło źle). Mapa OSM/Leaflet w WebView
// (uniwersalna: iOS/Android/Chiny, bez klucza, działa też w Expo Go), pin = środek mapy → „Szukaj tutaj".
// Plus: „Moja lokalizacja" (GPS), szukanie po nazwie/mieście, a każdy wynik ma link do Google Maps.
//
// <VenueMap> jest wrapperem — DZIŚ renderuje OSM w WebView. Można później dołożyć natywną mapę
// (react-native-maps: iOS Apple / Android Google) i wybierać ją wg dostępności, bez ruszania ekranu.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { colors } from "./theme";
import { fetchRestaurant } from "./api";
import type { GeoPoint, RestaurantInfo } from "./types";

interface Props {
  initialLocation: GeoPoint | null;
  cuisine?: string;
  targetLang: string;
  onClose: () => void;
  onPick: (r: RestaurantInfo) => void;
}

const DEFAULT_CENTER: GeoPoint = { lat: 40.4168, lng: -3.7038 }; // Madryt — zanim padnie GPS/lokal skanu

// Odległość lokalu od „miejsca gdzie jesteśmy" (pozycja skanu / GPS) — haversine w metrach.
function distanceM(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Format dystansu: <1 km zaokrąglone do 5 m (bez fałszywej precyzji), wyżej w km.
function fmtDist(m: number): string {
  return m < 1000 ? `${Math.round(m / 5) * 5} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
const NEARBY_RADIUS = 1500;

/** Mapa: dziś OSM/Leaflet w WebView (wszędzie działa). Pin rysujemy w RN na środku — środek = punkt szukania. */
function VenueMap({ center, scanLocation, selectedVenue, onCenterChange, webRef }: { center: GeoPoint; scanLocation: GeoPoint | null; selectedVenue: GeoPoint | null; onCenterChange: (g: GeoPoint) => void; webRef: React.RefObject<WebView | null> }) {
  // HTML budujemy RAZ (z pierwszym centrum); kolejne re-centrowania idą przez injectJavaScript(recenter()).
  const html = useMemo(
    () => `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#map{height:100%;margin:0;padding:0;background:#e8e0d0}</style></head>
<body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var map=L.map('map',{zoomControl:true,attributionControl:false}).setView([${center.lat},${center.lng}],16);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
  function send(){var c=map.getCenter();if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({lat:c.lat,lng:c.lng}));}
  map.on('moveend',send);
  window.recenter=function(la,ln){map.setView([la,ln],16);};
  // MIEJSCE SKANU (zawsze widoczne) — niebieskie kółko.
  ${scanLocation ? `L.circleMarker([${scanLocation.lat},${scanLocation.lng}],{radius:8,color:'#2b6cb0',fillColor:'#5aa9e6',fillOpacity:0.95,weight:3}).addTo(map).bindTooltip('📷 miejsce skanu');` : ""}
  // WYBRANY LOKAL — pin (ustawiany po kliknięciu wyniku).
  var venueM=null;
  window.setVenue=function(la,ln){ if(venueM){map.removeLayer(venueM);venueM=null;} if(la==null||ln==null)return; venueM=L.marker([la,ln]).addTo(map).bindTooltip('🏠 wybrany lokal',{permanent:true,direction:'top'}); map.setView([la,ln],16); };
</script></body></html>`,
    // celowo bez zależności — przebudowa HTML zresetowałaby przesunięcie mapy (scanLocation jest stały)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Klik w wynik → pin wybranego lokalu (i re-centrowanie). Inject, gdy WebView gotowy.
  useEffect(() => {
    webRef.current?.injectJavaScript(`window.setVenue&&window.setVenue(${selectedVenue ? `${selectedVenue.lat},${selectedVenue.lng}` : "null,null"});true;`);
  }, [selectedVenue, webRef]);
  return (
    <View style={styles.mapWrap}>
      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={{ html }}
        style={styles.map}
        onMessage={(e) => {
          try {
            const c = JSON.parse(e.nativeEvent.data);
            if (typeof c.lat === "number" && typeof c.lng === "number") onCenterChange({ lat: c.lat, lng: c.lng });
          } catch {
            /* ignore */
          }
        }}
      />
      {/* Pin na środku (RN, nad mapą) — środek mapy = punkt „Szukaj tutaj". */}
      <View pointerEvents="none" style={styles.centerPin}>
        <Text style={styles.centerPinText}>📍</Text>
      </View>
    </View>
  );
}

export function VenueSearchScreen({ initialLocation, cuisine, targetLang, onClose, onPick }: Props) {
  const insets = useSafeAreaInsets(); // ekran jest full-screen overlay (absoluteFill) → bez tego header wchodzi pod notch
  const webRef = useRef<WebView>(null);
  const [center, setCenter] = useState<GeoPoint>(initialLocation ?? DEFAULT_CENTER);
  const [me, setMe] = useState<GeoPoint | null>(initialLocation); // „gdzie jesteśmy" — do dystansu w wynikach
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [cuisineQ, setCuisineQ] = useState(cuisine ?? ""); // kuchnia z menu — edytowalna, zawęża „w pobliżu"
  const [results, setResults] = useState<RestaurantInfo[]>([]);
  const [selected, setSelected] = useState<RestaurantInfo | null>(null); // klik wyniku → zaznacz na mapie (bez zamykania)
  const [loading, setLoading] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const dedupe = (list: (RestaurantInfo | null)[]) => {
    const seen = new Set<string>();
    const out: RestaurantInfo[] = [];
    for (const r of list) if (r && !seen.has(r.placeId)) { seen.add(r.placeId); out.push(r); }
    return out;
  };

  async function searchAt(loc: GeoPoint) {
    setLoading(true);
    setNote(null);
    try {
      const { candidates } = await fetchRestaurant({ forceNearby: true, cuisine: cuisineQ.trim() || undefined, location: loc, targetLang, radius: NEARBY_RADIUS });
      setResults(candidates);
      if (candidates.length === 0) setNote("Brak lokali w tym miejscu — przesuń mapę lub poszukaj po nazwie.");
    } catch {
      setNote("Wyszukiwanie nie powiodło się. Spróbuj ponownie.");
    } finally {
      setLoading(false);
    }
  }

  async function searchText() {
    const q = name.trim();
    if (!q) return;
    setLoading(true);
    setNote(null);
    try {
      const { restaurant, candidates } = await fetchRestaurant({
        name: q,
        address: city.trim() || undefined,
        cuisine: cuisineQ.trim() || undefined,
        location: center,
        targetLang,
      });
      const list = dedupe([restaurant, ...candidates]);
      setResults(list);
      if (list.length === 0) setNote("Nic nie znalazłem dla tej nazwy. Dodaj miasto albo poszukaj na mapie.");
    } catch {
      setNote("Wyszukiwanie nie powiodło się. Spróbuj ponownie.");
    } finally {
      setLoading(false);
    }
  }

  async function useMyLocation() {
    setGpsLoading(true);
    setNote(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        setNote("Brak zgody na lokalizację. Możesz wpisać nazwę/miasto albo przesunąć mapę.");
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setCenter(loc);
      setMe(loc); // świeży GPS = aktualne „gdzie jesteśmy" (dystans liczymy od niego)
      webRef.current?.injectJavaScript(`window.recenter && window.recenter(${loc.lat},${loc.lng}); true;`);
      await searchAt(loc);
    } catch {
      setNote("Nie udało się pobrać lokalizacji GPS.");
    } finally {
      setGpsLoading(false);
    }
  }

  // Start: lokal skanu → pokaż lokale dookoła; brak → spróbuj GPS.
  useEffect(() => {
    if (initialLocation) void searchAt(initialLocation);
    else void useMyLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openInMaps = (r: RestaurantInfo) => {
    const url = r.mapsUri || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([r.name, r.address].filter(Boolean).join(" "))}`;
    void Linking.openURL(url);
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onClose} hitSlop={10} style={styles.backBtn}>
          <Text style={styles.backText}>← Wróć</Text>
        </Pressable>
        <Text style={styles.title}>Znajdź lokal</Text>
        <View style={{ width: 64 }} />
      </View>

      <VenueMap center={center} scanLocation={initialLocation} selectedVenue={selected?.location ?? null} onCenterChange={setCenter} webRef={webRef} />
      <View style={styles.mapActions}>
        <Pressable style={[styles.mapBtn, styles.mapBtnPrimary]} onPress={() => searchAt(center)} disabled={loading}>
          <Text style={styles.mapBtnPrimaryText}>🔍 Szukaj tutaj</Text>
        </Pressable>
        <Pressable style={styles.mapBtn} onPress={useMyLocation} disabled={gpsLoading}>
          <Text style={styles.mapBtnText}>{gpsLoading ? "⏳ GPS…" : "📍 Moja lokalizacja"}</Text>
        </Pressable>
      </View>

      <View style={styles.cuisineRow}>
        <Text style={styles.cuisineLabel}>🍽 Kuchnia</Text>
        <TextInput
          value={cuisineQ}
          onChangeText={setCuisineQ}
          placeholder="dowolna kuchnia (zawęża w pobliżu)"
          placeholderTextColor={colors.muted}
          style={styles.cuisineInput}
        />
        {cuisineQ.trim() ? (
          <Pressable onPress={() => setCuisineQ("")} hitSlop={8} style={styles.cuisineClear}>
            <Text style={styles.cuisineClearText}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.searchRow}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Nazwa lokalu"
          placeholderTextColor={colors.muted}
          style={[styles.input, { flex: 2 }]}
          returnKeyType="search"
          onSubmitEditing={searchText}
        />
        <TextInput
          value={city}
          onChangeText={setCity}
          placeholder="Miasto"
          placeholderTextColor={colors.muted}
          style={[styles.input, { flex: 1 }]}
          returnKeyType="search"
          onSubmitEditing={searchText}
        />
        <Pressable style={styles.searchBtn} onPress={searchText}>
          <Text style={styles.searchBtnText}>🔎</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.results} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        {loading ? (
          <View style={styles.centerRow}><ActivityIndicator color={colors.accent} /><Text style={styles.noteText}>  Szukam…</Text></View>
        ) : null}
        {note && !loading ? <Text style={styles.noteText}>{note}</Text> : null}
        {results.map((r) => (
          <View key={r.placeId} style={[styles.card, selected?.placeId === r.placeId && styles.cardSelected]}>
            <Pressable style={{ flex: 1 }} onPress={() => setSelected(r)}>
              <Text style={styles.cardName} numberOfLines={1}>{selected?.placeId === r.placeId ? "📍 " : ""}{r.name}</Text>
              {r.address ? <Text style={styles.cardAddr} numberOfLines={1}>{r.address}</Text> : null}
              <Text style={styles.cardMeta}>
                {me && r.location ? <Text style={styles.cardDist}>📍 {fmtDist(distanceM(me, r.location))}</Text> : null}
                {me && r.location ? " · " : ""}
                {r.cuisine ? `🍽 ${r.cuisine} · ` : ""}
                {r.rating != null ? `★ ${r.rating.toFixed(1)}${r.ratingCount != null ? ` (${r.ratingCount})` : ""}` : "bez ocen"}
                {r.openNow != null ? ` · ${r.openNow ? "otwarte" : "zamknięte"}` : ""}
              </Text>
            </Pressable>
            <View style={styles.cardActions}>
              <Pressable style={styles.mapsLink} onPress={() => openInMaps(r)}>
                <Text style={styles.mapsLinkText}>🗺 Maps</Text>
              </Pressable>
              <Pressable style={styles.pickBtn} onPress={() => onPick(r)}>
                <Text style={styles.pickBtnText}>✓ Wybierz</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.badgeBg, backgroundColor: colors.card },
  backBtn: { paddingVertical: 6, paddingRight: 8, width: 64 },
  backText: { color: colors.accent, fontWeight: "800", fontSize: 15 },
  title: { fontSize: 17, fontWeight: "800", color: colors.text },
  mapWrap: { height: 240, marginHorizontal: 12, borderRadius: 14, overflow: "hidden", backgroundColor: "#e8e0d0", position: "relative" },
  map: { flex: 1, backgroundColor: "transparent" },
  centerPin: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  centerPinText: { fontSize: 30, marginBottom: 28 /* czubek pinezki na środku */ },
  mapActions: { flexDirection: "row", gap: 8, paddingHorizontal: 12, marginTop: 8 },
  mapBtn: { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: "center", backgroundColor: colors.badgeBg },
  mapBtnText: { color: colors.badgeText, fontWeight: "700", fontSize: 14 },
  mapBtnPrimary: { backgroundColor: colors.accent },
  mapBtnPrimaryText: { color: colors.buttonText, fontWeight: "800", fontSize: 14 },
  cuisineRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, marginTop: 8 },
  cuisineLabel: { fontSize: 13, fontWeight: "700", color: colors.muted },
  cuisineInput: { flex: 1, backgroundColor: colors.card, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: colors.text, borderWidth: 1, borderColor: colors.badgeBg },
  cuisineClear: { paddingHorizontal: 6, paddingVertical: 4 },
  cuisineClearText: { color: colors.muted, fontSize: 15, fontWeight: "800" },
  searchRow: { flexDirection: "row", gap: 8, paddingHorizontal: 12, marginTop: 10 },
  input: { backgroundColor: colors.card, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text, borderWidth: 1, borderColor: colors.badgeBg },
  searchBtn: { paddingHorizontal: 16, justifyContent: "center", backgroundColor: colors.badgeBg, borderRadius: 10 },
  searchBtnText: { fontSize: 18 },
  results: { flex: 1, marginTop: 10, paddingHorizontal: 12 },
  centerRow: { flexDirection: "row", alignItems: "center", paddingVertical: 16 },
  noteText: { color: colors.muted, fontSize: 13, paddingVertical: 12, lineHeight: 18 },
  card: { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.badgeBg },
  cardSelected: { borderColor: colors.accent, backgroundColor: colors.accent + "14" }, // klik → zaznaczony na mapie
  cardName: { fontSize: 15, fontWeight: "800", color: colors.text },
  cardDist: { color: colors.accent, fontWeight: "800" }, // dystans „od nas" — wyróżniony
  cardAddr: { fontSize: 12.5, color: colors.muted, marginTop: 2 },
  cardMeta: { fontSize: 12, color: colors.muted, marginTop: 3 },
  cardActions: { alignItems: "flex-end", gap: 6, marginLeft: 8 },
  mapsLink: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.badgeBg },
  mapsLinkText: { color: colors.badgeText, fontWeight: "700", fontSize: 12 },
  pickBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: colors.accent },
  pickBtnText: { color: colors.buttonText, fontWeight: "800", fontSize: 12 },
});
