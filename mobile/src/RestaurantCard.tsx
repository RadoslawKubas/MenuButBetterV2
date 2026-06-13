// Karta restauracji z Google Places: zdjęcie, ocena, godziny, adres, link do Map.
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { placePhotoUrl } from "./api";
import { colors } from "./theme";
import { Lightbox, type LightboxPhoto, type LightboxState } from "./Lightbox";
import { resolveCachedUri } from "./imageCache";
import type { RestaurantInfo } from "./types";

const PRICE: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "€",
  PRICE_LEVEL_MODERATE: "€€",
  PRICE_LEVEL_EXPENSIVE: "€€€",
  PRICE_LEVEL_VERY_EXPENSIVE: "€€€€",
};

export function RestaurantCard({
  restaurant,
  loading,
  candidates,
  nearbyLoading,
  onPick,
  onSearchByName,
  onSearchNearby,
  onExpandSearch,
  onRemove,
}: {
  restaurant: RestaurantInfo | null;
  loading: boolean;
  candidates?: RestaurantInfo[];
  nearbyLoading?: boolean;
  onPick?: (r: RestaurantInfo) => void;
  onSearchByName?: () => void;
  onSearchNearby?: () => void;
  onExpandSearch?: () => void;
  onRemove?: () => void;
}) {
  const [preview, setPreview] = useState<LightboxState | null>(null);

  if (loading) {
    return (
      <View style={[styles.card, styles.loadingCard]}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.loadingText}>  Szukam lokalu w Google Maps…</Text>
      </View>
    );
  }
  if (!restaurant) return null;

  const r = restaurant;
  const cityLine = [r.city, r.country].filter(Boolean).join(", ");
  const ta = r.tripAdvisor;

  // Jedna grupa zdjęć lokalu (Google + TripAdvisor) do przesuwania w podglądzie.
  // Preferuj lokalny plik (offline, bez wygasania linków); w razie braku — proxy Google.
  // Lokalny plik trzymamy jako referencję względną → składamy bezwzględny URI przy renderze.
  const googleUrls = r.photoNames.map((n, i) => {
    const cached = r.photoUris?.[i];
    return cached ? resolveCachedUri(cached)! : placePhotoUrl(n, 1000);
  });
  const taUrls = (ta?.photos ?? []).map((p) => resolveCachedUri(p.url)!);
  const allPhotos = [...googleUrls, ...taUrls];
  // Zdjęcia lokalu są z definicji „z tego lokalu" (★) — Google Maps + TripAdvisor.
  const lbPhotos: LightboxPhoto[] = [
    ...googleUrls.map((url) => ({ url, source: "google", fromVenue: true })),
    ...taUrls.map((url) => ({ url, source: "tripadvisor", fromVenue: true, attribution: "TripAdvisor" })),
  ];
  const open = (i: number) => setPreview({ photos: lbPhotos, index: i });

  return (
    <View style={styles.card}>
      {googleUrls[0] ? (
        <Pressable onPress={() => open(0)}>
          <Image source={{ uri: googleUrls[0] }} style={styles.photo} />
        </Pressable>
      ) : null}
      <View style={styles.body}>
        <Text style={styles.name}>{r.name}</Text>

        <View style={styles.metaRow}>
          {r.rating != null ? (
            <Text style={styles.rating}>
              ★ {r.rating.toFixed(1)}
              {r.ratingCount != null ? ` (${r.ratingCount})` : ""} Google
            </Text>
          ) : null}
          {ta?.rating != null ? (
            <Text style={styles.taRating}>
              🦉 {ta.rating.toFixed(1)}
              {ta.reviews != null ? ` (${ta.reviews})` : ""} TripAdvisor
            </Text>
          ) : null}
          {r.priceLevel && PRICE[r.priceLevel] ? (
            <Text style={styles.price}>{PRICE[r.priceLevel]}</Text>
          ) : null}
          {r.openNow != null ? (
            <Text style={[styles.open, r.openNow ? styles.openYes : styles.openNo]}>
              {r.openNow ? "Otwarte" : "Zamknięte"}
            </Text>
          ) : null}
        </View>

        {cityLine ? <Text style={styles.city}>{cityLine}</Text> : null}
        {r.address ? <Text style={styles.address}>{r.address}</Text> : null}

        {(candidates && candidates.length > 0) || r.guessedByLocation ? (
          <View style={styles.guessBox}>
            <Text style={styles.guessNote}>
              {r.guessedByLocation
                ? "📍 Dopasowano po lokalizacji i kuchni (nie znaleziono nazwy w menu). "
                : ""}
              {candidates && candidates.length > 0
                ? "To nie ten lokal? Wybierz właściwy z pobliża:"
                : ""}
              {nearbyLoading ? "  ⏳ szukam…" : ""}
            </Text>
            {candidates && candidates.length > 0 && onPick ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips}>
                {candidates.map((c) => {
                  const active = c.placeId === r.placeId;
                  return (
                    <Pressable
                      key={c.placeId}
                      onPress={() => !active && onPick(c)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {active ? "✓ " : ""}
                        {c.name}
                        {c.rating != null ? ` · ★${c.rating.toFixed(1)}` : ""}
                      </Text>
                    </Pressable>
                  );
                })}
                {onExpandSearch ? (
                  <Pressable onPress={onExpandSearch} style={[styles.chip, styles.chipExpand]}>
                    <Text style={styles.chipText}>🔭 Szerszy zasięg</Text>
                  </Pressable>
                ) : null}
              </ScrollView>
            ) : null}
          </View>
        ) : null}

        {r.photoNames.length > 1 ? (
          <View style={styles.gallery}>
            <Text style={styles.galleryLabel}>Zdjęcia z Google</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {r.photoNames.slice(1).map((name, i) => (
                <Pressable key={i} onPress={() => open(i + 1)}>
                  <Image source={{ uri: googleUrls[i + 1] }} style={styles.galleryPhoto} />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {ta?.photos && ta.photos.length > 0 ? (
          <View style={styles.gallery}>
            <Text style={styles.galleryLabel}>Zdjęcia z TripAdvisor</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {ta.photos.map((p, i) => (
                <Pressable key={i} onPress={() => open(googleUrls.length + i)}>
                  <Image source={{ uri: taUrls[i] }} style={styles.galleryPhoto} />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}

        <View style={styles.actions}>
          {r.mapsUri ? (
            <Pressable style={styles.action} onPress={() => Linking.openURL(r.mapsUri!)}>
              <Text style={styles.actionText}>🗺️ Mapy</Text>
            </Pressable>
          ) : null}
          {ta?.url ? (
            <Pressable style={styles.action} onPress={() => Linking.openURL(ta.url!)}>
              <Text style={styles.actionText}>🦉 TripAdvisor</Text>
            </Pressable>
          ) : null}
          {r.phone ? (
            <Pressable style={styles.action} onPress={() => Linking.openURL(`tel:${r.phone}`)}>
              <Text style={styles.actionText}>📞 Zadzwoń</Text>
            </Pressable>
          ) : null}
          {r.website ? (
            <Pressable style={styles.action} onPress={() => Linking.openURL(r.website!)}>
              <Text style={styles.actionText}>🌐 Strona</Text>
            </Pressable>
          ) : null}
        </View>

        {/* Korekta dopasowania lokalu: szukaj po nazwie, w pobliżu, lub usuń. */}
        {onSearchByName || onSearchNearby || onRemove ? (
          <View style={styles.fixRow}>
            {onSearchByName ? (
              <Pressable style={styles.fixBtn} onPress={onSearchByName}>
                <Text style={styles.fixText}>🔎 Szukaj po nazwie</Text>
              </Pressable>
            ) : null}
            {onSearchNearby ? (
              <Pressable style={styles.fixBtn} onPress={onSearchNearby}>
                <Text style={styles.fixText}>🔄 Inny w pobliżu</Text>
              </Pressable>
            ) : null}
            {onRemove ? (
              <Pressable style={styles.fixBtn} onPress={onRemove}>
                <Text style={styles.fixText}>✕ Usuń lokal</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>

      <Lightbox state={preview} onClose={() => setPreview(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    marginBottom: 20,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  loadingCard: { flexDirection: "row", alignItems: "center", padding: 16 },
  loadingText: { color: colors.muted, fontSize: 14 },
  photo: { width: "100%", height: 170, backgroundColor: colors.badgeBg },
  body: { padding: 16 },
  name: { fontSize: 20, fontWeight: "800", color: colors.text },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6, flexWrap: "wrap" },
  rating: { fontSize: 15, fontWeight: "700", color: colors.accent },
  taRating: { fontSize: 15, fontWeight: "700", color: "#00a680" },
  price: { fontSize: 15, fontWeight: "700", color: colors.muted },
  open: { fontSize: 13, fontWeight: "700" },
  openYes: { color: "#2e7d32" },
  openNo: { color: colors.error },
  guessBox: {
    marginTop: 12,
    backgroundColor: colors.badgeBg,
    borderRadius: 10,
    padding: 10,
  },
  guessNote: { fontSize: 12, color: colors.muted, lineHeight: 17 },
  chips: { marginTop: 8 },
  chip: {
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipExpand: { borderStyle: "dashed", borderColor: colors.accent },
  chipText: { fontSize: 13, color: colors.text, fontWeight: "600" },
  chipTextActive: { color: "#fff" },
  city: { fontSize: 14, color: colors.text, marginTop: 8, fontWeight: "600" },
  address: { fontSize: 13, color: colors.muted, marginTop: 2 },
  gallery: { marginTop: 14 },
  galleryLabel: { fontSize: 12, color: colors.muted, fontWeight: "700", marginBottom: 8 },
  galleryPhoto: { width: 130, height: 100, borderRadius: 10, marginRight: 8, backgroundColor: colors.badgeBg },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 14 },
  action: {
    backgroundColor: colors.badgeBg,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  actionText: { color: colors.accent, fontWeight: "700", fontSize: 14 },
  fixRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.badgeBg,
    paddingTop: 12,
  },
  fixBtn: { paddingHorizontal: 4, paddingVertical: 4 },
  fixText: { color: colors.muted, fontWeight: "600", fontSize: 13 },
});
