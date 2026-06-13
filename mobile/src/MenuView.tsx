// Render przetłumaczonego menu. Karty są interaktywne: dotknięcie rozwija
// „więcej info" (dociągane na żądanie i cache'owane). Znacznik ✓ = już pobrane.
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { Menu, MenuItem } from "./types";
import { colors } from "./theme";
import { Lightbox, type LightboxPhoto, type LightboxState } from "./Lightbox";
import { sourceMeta } from "./photoSource";
import { CachedImage } from "./CachedImage";

// Mapuje zdjęcia dania na model podglądu (z info o źródle, by pokazać je w galerii).
function toLightbox(photos: MenuItem["photos"]): LightboxPhoto[] {
  return (photos ?? []).map((p) => ({
    url: p.url,
    source: p.source,
    fromVenue: p.fromVenue,
    attribution: p.attribution,
  }));
}

// Lekkie czyszczenie markdownu, żeby tekst czytał się ładnie jako zwykły tekst.
function clean(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/`/g, "")
    .trim();
}

function Badges({ item }: { item: MenuItem }) {
  const badges: string[] = [];
  if (item.dietary.vegan) badges.push("🌱 wega");
  else if (item.dietary.vegetarian) badges.push("🥕 wege");
  if (item.dietary.gluten_free) badges.push("🚫 gluten");
  if (item.spice_level > 0) badges.push("🌶️".repeat(item.spice_level));
  if (badges.length === 0) return null;
  return (
    <View style={styles.badgeRow}>
      {badges.map((b, i) => (
        <View key={i} style={styles.badge}>
          <Text style={styles.badgeText}>{b}</Text>
        </View>
      ))}
    </View>
  );
}

function InfoFooter({
  item,
  expanded,
  loading,
  photoLoading,
  onPhotoOpen,
}: {
  item: MenuItem;
  expanded: boolean;
  loading: boolean; // generowanie OPISU (gdy go brak)
  photoLoading: boolean; // doszukiwanie LEPSZYCH zdjęć (w tle, nie blokuje)
  onPhotoOpen: (state: LightboxState) => void;
}) {
  const photos = item.photos ?? [];
  const hasCache = !!item.extraInfo || photos.length > 0;
  const anyRepresentative = photos.some((p) => p.representative);

  // Rozwinięte: pokazujemy WSZYSTKO co już jest OD RAZU — opis nie czeka na zdjęcia.
  if (expanded) {
    return (
      <View style={styles.infoBox}>
        {photos.length > 0 ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoStrip}>
              {photos.map((p, i) => (
                <Pressable
                  key={i}
                  onPress={() => onPhotoOpen({ photos: toLightbox(photos), index: i })}
                  style={styles.dishPhotoWrap}
                >
                  <CachedImage uri={p.url} remoteUrl={p.remoteUrl} style={styles.dishPhoto} />
                  {p.verified ? (
                    <View style={styles.verifiedBadge}>
                      <Text style={styles.verifiedText}>✓</Text>
                    </View>
                  ) : null}
                  {p.fromVenue ? (
                    <View style={styles.venueBadge}>
                      <Text style={styles.venueBadgeText}>★</Text>
                    </View>
                  ) : null}
                  <View style={[styles.sourceBar, { backgroundColor: sourceMeta(p.source).color }]}>
                    <Text style={styles.sourceBarText} numberOfLines={1}>
                      {sourceMeta(p.source).label}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
            <Text style={styles.photoNote}>
              {anyRepresentative ? "🔸 Poglądowe (typ dania) · " : "📷 "}dotknij, by powiększyć
            </Text>
          </>
        ) : null}
        {photoLoading ? <Text style={styles.photoNote}>⏳ Doszukuję lepszych zdjęć…</Text> : null}
        {item.extraInfo ? (
          <Text style={styles.infoText}>{clean(item.extraInfo)}</Text>
        ) : loading ? (
          <View style={styles.infoRow}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.infoHint}>  Generuję opis…</Text>
          </View>
        ) : null}
        <Text style={styles.infoToggle}>▲ Zwiń</Text>
      </View>
    );
  }
  if (hasCache) {
    return (
      <View style={styles.infoRow}>
        <Text style={styles.infoAvail}>
          ℹ️ Więcej info{photos.length > 0 ? " i zdjęcia" : ""} ✓
        </Text>
      </View>
    );
  }
  if (loading) {
    return (
      <View style={styles.infoRow}>
        <ActivityIndicator size="small" color={colors.accent} />
        <Text style={styles.infoHint}>  Pobieram…</Text>
      </View>
    );
  }
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoHint}>ℹ️ Więcej info ›</Text>
    </View>
  );
}

export function MenuView({
  menu,
  infoLoading,
  photoLoading,
  onItemPress,
  nameFallback,
}: {
  menu: Menu;
  infoLoading: Set<string>;
  photoLoading: Set<string>;
  onItemPress: (sectionIndex: number, itemIndex: number) => void;
  /** Nazwa z dopasowanego lokalu — gdy menu nie miało własnej nazwy. */
  nameFallback?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<LightboxState | null>(null);
  const headerName = menu.restaurant_name || nameFallback || null;

  function press(si: number, ii: number, item: MenuItem) {
    const key = `${si}-${ii}`;
    const willExpand = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // Zawsze odpalamy na rozwinięciu — loadInfo sam decyduje, czego brakuje (opis/lepsze zdjęcia).
    if (willExpand) onItemPress(si, ii);
  }

  return (
    <View>
      {headerName || menu.restaurant_address ? (
        <View style={styles.restaurantHeader}>
          {headerName ? <Text style={styles.restaurantName}>{headerName}</Text> : null}
          {menu.restaurant_address ? (
            <Text style={styles.restaurantAddress}>{menu.restaurant_address}</Text>
          ) : null}
        </View>
      ) : null}

      {menu.sections.map((section, si) => (
        <View key={si} style={styles.section}>
          <Text style={styles.sectionTitle}>{section.name_translated}</Text>
          <Text style={styles.sectionOriginal}>{section.name}</Text>
          {section.items.map((item, ii) => {
            const key = `${si}-${ii}`;
            return (
              <Pressable key={ii} style={styles.card} onPress={() => press(si, ii, item)}>
                <View style={styles.cardRow}>
                  <View style={styles.cardMain}>
                    <View style={styles.cardHeader}>
                      <Text style={styles.itemName}>{item.translated}</Text>
                      {item.price ? (
                        <Text style={styles.price}>
                          {item.price}
                          {item.currency ? ` ${item.currency}` : ""}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.original}>{item.original}</Text>
                    <Badges item={item} />
                    <Text style={styles.description}>{item.description}</Text>
                    {item.allergens.length > 0 ? (
                      <Text style={styles.allergens}>Alergeny: {item.allergens.join(", ")}</Text>
                    ) : null}
                  </View>
                  {(() => {
                    const photo = item.photos?.[0];
                    return (
                      <Pressable
                        style={styles.cardThumbWrap}
                        onPress={() => photo && setPreview({ photos: toLightbox(item.photos), index: 0 })}
                        disabled={!photo}
                      >
                        {/* Wyblakły placeholder zawsze pod spodem — daje stały rozmiar i tło, więc
                            layout się nie przesuwa, gdy zdjęcia brak albo jeszcze się ładuje. */}
                        <View style={[styles.cardThumb, styles.thumbPlaceholder]}>
                          <Text style={styles.thumbPlaceholderGlyph}>🍽️</Text>
                        </View>
                        {photo ? (
                          <CachedImage
                            uri={photo.url}
                            remoteUrl={photo.remoteUrl}
                            style={[styles.cardThumb, styles.thumbAbs]}
                          />
                        ) : null}
                        {photo?.verified ? (
                          <View style={styles.cardThumbVerified}>
                            <Text style={styles.verifiedText}>✓</Text>
                          </View>
                        ) : null}
                        {photo?.fromVenue ? (
                          <View style={styles.cardThumbVenue}>
                            <Text style={styles.cardThumbVenueText}>★</Text>
                          </View>
                        ) : null}
                        {photo ? (
                          <View
                            style={[
                              styles.cardThumbSource,
                              { backgroundColor: sourceMeta(photo.source).color },
                            ]}
                          >
                            <Text style={styles.cardThumbSourceText} numberOfLines={1}>
                              {sourceMeta(photo.source).short}
                            </Text>
                          </View>
                        ) : null}
                      </Pressable>
                    );
                  })()}
                </View>
                <InfoFooter
                  item={item}
                  expanded={expanded.has(key)}
                  loading={infoLoading.has(key)}
                  photoLoading={photoLoading.has(key)}
                  onPhotoOpen={setPreview}
                />
              </Pressable>
            );
          })}
        </View>
      ))}

      {/* Podgląd zdjęć w aplikacji (swipe lewo/prawo w obrębie dania) */}
      <Lightbox state={preview} onClose={() => setPreview(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  restaurantHeader: { marginBottom: 20 },
  restaurantName: { fontSize: 26, fontWeight: "800", color: colors.accent },
  restaurantAddress: { fontSize: 14, color: colors.muted, marginTop: 2 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 22, fontWeight: "700", color: colors.accent },
  sectionOriginal: { fontSize: 13, color: colors.muted, marginBottom: 10, fontStyle: "italic" },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardRow: { flexDirection: "row" },
  cardMain: { flex: 1 },
  // alignSelf flex-start — żeby opakowanie nie rozciągało się na wysokość karty (stretch),
  // inaczej pasek źródła (bottom:0) ląduje POD zdjęciem, nie na nim.
  cardThumbWrap: { marginLeft: 12, position: "relative", alignSelf: "flex-start" },
  cardThumb: { width: 72, height: 72, borderRadius: 10, backgroundColor: colors.badgeBg },
  // Wyblakły placeholder pod miniaturką (stały rozmiar → brak skoków layoutu).
  thumbPlaceholder: { alignItems: "center", justifyContent: "center", opacity: 0.5 },
  thumbPlaceholderGlyph: { fontSize: 26, opacity: 0.35 },
  // Zdjęcie nakładane na placeholder (wypełnia ten sam box).
  thumbAbs: { position: "absolute", top: 0, left: 0 },
  cardThumbVerified: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "#2e7d32",
    borderRadius: 999,
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  // Gwiazdka „z tego lokalu" na małej miniaturce karty (lewy górny róg).
  cardThumbVenue: {
    position: "absolute",
    top: 4,
    left: 4,
    backgroundColor: "#b8860b",
    borderRadius: 999,
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  cardThumbVenueText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  itemName: { fontSize: 17, fontWeight: "700", color: colors.text, flex: 1, paddingRight: 8 },
  price: { fontSize: 16, fontWeight: "700", color: colors.text },
  original: { fontSize: 13, color: colors.muted, marginTop: 2, fontStyle: "italic" },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  badge: { backgroundColor: colors.badgeBg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 12, color: colors.badgeText },
  description: { fontSize: 14, color: colors.text, lineHeight: 20, marginTop: 8 },
  allergens: { fontSize: 12, color: colors.muted, marginTop: 8 },
  infoRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  infoHint: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  infoAvail: { fontSize: 13, color: colors.accent, fontWeight: "700" },
  infoBox: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.badgeBg, paddingTop: 10 },
  infoText: { fontSize: 14, color: colors.text, lineHeight: 21 },
  infoToggle: { fontSize: 13, color: colors.accent, fontWeight: "700", marginTop: 10 },
  photoStrip: { marginBottom: 6 },
  dishPhotoWrap: { marginRight: 8, position: "relative" },
  dishPhoto: { width: 150, height: 110, borderRadius: 10, backgroundColor: colors.badgeBg },
  verifiedBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: "#2e7d32",
    borderRadius: 999,
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  verifiedText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  // Gwiazdka „z tego lokalu" na dużym zdjęciu (lewy górny róg).
  venueBadge: {
    position: "absolute",
    top: 6,
    left: 6,
    backgroundColor: "#b8860b",
    borderRadius: 999,
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  venueBadgeText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  photoNote: { fontSize: 12, color: colors.muted, marginBottom: 10 },
  // Pasek źródła na zdjęciu w pasku rozwiniętym (z etykietą).
  sourceBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
  },
  sourceBarText: { color: "#fff", fontSize: 10, fontWeight: "800" },
  // Kolorowy pasek źródła na małej miniaturce karty — z mikro-etykietą.
  cardThumbSource: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 1,
    alignItems: "center",
    justifyContent: "center",
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
  },
  cardThumbSourceText: {
    color: "#fff",
    fontSize: 7,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
});
