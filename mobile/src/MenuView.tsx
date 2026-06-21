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
import type { Menu, MenuItem, MenuNote } from "./types";
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
    fromVenueReason: p.fromVenueReason,
    attribution: p.attribution,
    score: p.score,
    rejected: p.rejected,
  }));
}

// Domena z URL-a (do zwięzłego logu kandydatów, gdy API nie podało `domain`).
function hostOf(url: string): string {
  const m = url.match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1]!.replace(/^www\./, "") : url.slice(0, 32);
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

// Panel debug wyszukiwania zdjęć: jakie API użyto, ile zwróciły, ile trafnych, parametry.
function PhotoDebugPanel({ item }: { item: MenuItem }) {
  const d = item.photoDebug;
  if (!d) {
    return <Text style={styles.debugDim}>Brak danych — zdjęcia jeszcze nie szukane dla tej pozycji.</Text>;
  }
  const p = d.params;
  const s = (v: unknown) => (v == null || v === "" ? "—" : String(v));
  return (
    <View style={styles.debugBox}>
      <Text style={styles.debugLine}>
        zapytanie: „{s(p.dish)}"{p.photoQuery ? `  ·  photo_query: „${s(p.photoQuery)}"` : ""}
      </Text>
      <Text style={styles.debugLine}>
        lokal: {s(p.restaurantName)} · domena: {s(p.restaurantDomain)} · kuchnia: {s(p.cuisine)}
      </Text>
      <Text style={styles.debugLine}>
        tryb: {p.representativeOnly ? "poglądowe (start)" : "pełne (na dotknięcie)"} · weryfikacja:{" "}
        {p.verify ? "tak" : "nie"}
      </Text>
      <Text style={styles.debugHdr}>kroki (API · zwróciło → trafne):</Text>
      {d.steps.length === 0 ? (
        <Text style={styles.debugDim}>— brak —</Text>
      ) : (
        d.steps.map((st, i) => (
          <View key={i}>
            <Text style={styles.debugStep}>
              • {st.tier} [{st.provider}] „{st.query}" — zwróciło {st.returned}
              {st.passed != null ? ` → trafne ${st.passed}` : ""}
            </Text>
            {st.candidates?.map((cand, j) => (
              <View key={j}>
                <Text style={styles.debugCand} numberOfLines={1}>
                  {cand.passed === true ? "✓" : cand.passed === false ? "✗" : "·"}{" "}
                  {cand.score != null ? `${cand.score.toFixed(2)} ` : ""}
                  {cand.domain ?? hostOf(cand.url)}
                  {cand.fromVenue != null ? (cand.fromVenue ? "  ★ z lokalu" : "  ✗ nie z lokalu") : ""}
                </Text>
                {cand.fromVenueReason ? (
                  <Text style={[styles.debugCand, cand.fromVenue ? styles.venueOk : styles.venueNo]}>
                    ↳ {cand.fromVenueReason}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ))
      )}
      <Text style={styles.debugLine}>wynik: {d.resultCount} zdjęć</Text>
    </View>
  );
}

function InfoFooter({
  item,
  expanded,
  loading,
  photoLoading,
  onPhotoOpen,
  onSearchMore,
}: {
  item: MenuItem;
  expanded: boolean;
  loading: boolean; // generowanie OPISU (gdy go brak)
  photoLoading: boolean; // doszukiwanie LEPSZYCH zdjęć (na żądanie)
  onPhotoOpen: (state: LightboxState) => void;
  onSearchMore: () => void; // #4: tap „więcej zdjęć" → szukaj lepszych (zamiast auto)
}) {
  const [showDebug, setShowDebug] = useState(false);
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
                  <CachedImage uri={p.url} remoteUrl={p.remoteUrl} style={[styles.dishPhoto, p.rejected && styles.dishPhotoRejected]} />
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
                  {p.rejected ? (
                    <View style={styles.rejectedBadge}>
                      <Text style={styles.rejectedBadgeText}>❌ odrzuc.{p.score != null ? ` ${Math.round(p.score * 100)}%` : ""}</Text>
                    </View>
                  ) : null}
                  <View style={[styles.sourceBar, { backgroundColor: sourceMeta(p.source).color }]}>
                    <Text style={styles.sourceBarText} numberOfLines={1}>
                      {sourceMeta(p.source).label}
                    </Text>
                  </View>
                </Pressable>
              ))}
              {/* #4: kafel „więcej zdjęć" za pierwszym zdjęciem — szukanie lepszych dopiero na tap. */}
              {!item.photosUpgraded ? (
                <Pressable onPress={onSearchMore} disabled={photoLoading} style={[styles.dishPhotoWrap, styles.morePhotos]}>
                  {photoLoading ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <>
                      <Text style={styles.morePhotosGlyph}>🔍</Text>
                      <Text style={styles.morePhotosText}>więcej{"\n"}zdjęć</Text>
                    </>
                  )}
                </Pressable>
              ) : null}
            </ScrollView>
            <Text style={styles.photoNote}>
              {anyRepresentative ? "🔸 Poglądowe (typ dania) · " : "📷 "}dotknij zdjęcie, by powiększyć
            </Text>
          </>
        ) : !item.photosUpgraded ? (
          // Brak zdjęcia poglądowego — kafel do ręcznego poszukania (zamiast auto).
          <Pressable onPress={onSearchMore} disabled={photoLoading} style={[styles.dishPhoto, styles.morePhotos, styles.photoStrip]}>
            {photoLoading ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <>
                <Text style={styles.morePhotosGlyph}>🔍</Text>
                <Text style={styles.morePhotosText}>poszukaj zdjęć</Text>
              </>
            )}
          </Pressable>
        ) : (
          // Szukano, nic nie znaleziono — wyblakły placeholder.
          <View style={[styles.dishPhoto, styles.thumbPlaceholder, styles.photoStrip]}>
            <Text style={styles.thumbPlaceholderGlyph}>🍽️</Text>
          </View>
        )}
        {item.extraInfo ? (
          <Text style={styles.infoText}>{clean(item.extraInfo)}</Text>
        ) : loading ? (
          <View style={styles.infoRow}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={styles.infoHint}>  Generuję opis…</Text>
          </View>
        ) : null}
        {/* Debug wyszukiwania zdjęć (małe 🐛). */}
        <Pressable onPress={() => setShowDebug((v) => !v)} hitSlop={6}>
          <Text style={styles.debugBtn}>🐛 debug zdjęć {showDebug ? "▲" : "▾"}</Text>
        </Pressable>
        {showDebug ? <PhotoDebugPanel item={item} /> : null}
        <Text style={styles.infoToggle}>▲ Zwiń</Text>
      </View>
    );
  }
  if (hasCache) {
    return (
      <View style={styles.infoRow}>
        <Text style={styles.infoAvail}>
          ℹ️ Więcej info{photos.length > 1 ? ` i ${photos.length} zdjęcia` : photos.length === 1 ? " i zdjęcie" : ""} ✓
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

const NOTE_ICON: Record<string, string> = { set: "🎫", included: "🍽", wait: "⏱", fee: "➕", tax: "🧾", tip: "💶", hours: "🕒", info: "ℹ️" };

/** Adnotacje menu (czas oczekiwania, dopłaty, VAT…) — osobny blok, nie dania. */
function NotesBlock({ notes, title }: { notes: MenuNote[]; title?: string }) {
  if (!notes.length) return null;
  return (
    <View style={styles.notesBlock}>
      {title ? <Text style={styles.notesTitle}>{title}</Text> : null}
      {notes.map((n, i) => {
        const tr = (n.text_translated || n.text).trim();
        const showOrig = tr && tr !== n.text.trim();
        return (
          <View key={i} style={styles.noteRow}>
            <Text style={styles.noteIcon}>{NOTE_ICON[n.kind] || "ℹ️"}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.noteText}>{tr}</Text>
              {showOrig ? <Text style={styles.noteOriginal}>{n.text}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function MenuView({
  menu,
  infoLoading,
  photoLoading,
  onItemPress,
  onSearchMorePhotos,
  enriching,
  nameFallback,
}: {
  menu: Menu;
  infoLoading: Set<string>;
  photoLoading: Set<string>;
  onItemPress: (sectionIndex: number, itemIndex: number) => void;
  /** Enrich leci w tle (wszedłeś do menu w trakcie skanu) → pozycje bez `enriched` dostają spinner „tłumaczę…". */
  enriching?: boolean;
  /** #4: tap „więcej zdjęć" przy daniu → uruchom doszukiwanie lepszych (zamiast auto na rozwinięciu). */
  onSearchMorePhotos: (sectionIndex: number, itemIndex: number) => void;
  /** Nazwa z dopasowanego lokalu — gdy menu nie miało własnej nazwy. */
  nameFallback?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<LightboxState | null>(null);
  const headerName = menu.restaurant_name || nameFallback || null;

  function toggleSection(si: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(si)) next.delete(si);
      else next.add(si);
      return next;
    });
  }

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

      <NotesBlock
        title="ℹ️ Dobrze wiedzieć"
        notes={(menu.notes ?? []).filter((n) => n.scope === "menu" || n.section_index == null)}
      />

      {menu.sections.map((section, si) => {
        const isCollapsed = collapsed.has(si);
        const secNotes = (menu.notes ?? []).filter((n) => n.scope === "section" && n.section_index === si);
        return (
        <View key={si} style={styles.section}>
          <Pressable onPress={() => toggleSection(si)} style={styles.sectionHeader}>
            <Text style={styles.sectionChevron}>{isCollapsed ? "▸" : "▾"}</Text>
            <View style={styles.sectionHeaderText}>
              <Text style={styles.sectionTitle}>
                {section.name_translated}
                <Text style={styles.sectionCount}>  ({section.items.length})</Text>
              </Text>
              <Text style={styles.sectionOriginal}>{section.name}</Text>
              {section.availability ? (
                <View style={styles.availBadge}>
                  <Text style={styles.availText}>⏰ {section.availability}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
          {!isCollapsed ? <NotesBlock notes={secNotes} /> : null}
          {!isCollapsed && section.items.map((item, ii) => {
            const key = `${si}-${ii}`;
            return (
              <Pressable key={ii} style={styles.card} onPress={() => press(si, ii, item)}>
                <View style={styles.cardRow}>
                  <View style={styles.cardMain}>
                    <View style={styles.cardHeader}>
                      <Text style={styles.itemName}>{item.translated}</Text>
                      {item.price && !(item.variants && item.variants.length > 0) ? (
                        <Text style={styles.price} numberOfLines={2}>
                          {item.price}
                          {item.currency ? ` ${item.currency}` : ""}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.original}>{item.original}</Text>
                    {item.variants && item.variants.length > 0 ? (
                      <View style={styles.variantsRow}>
                        {item.variants.map((v, k) => (
                          <View key={k} style={styles.variantPill}>
                            <Text style={styles.variantLabel}>{v.label}</Text>
                            <Text style={styles.variantPrice}>{v.price}{item.currency ? ` ${item.currency}` : ""}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    {enriching && !item.enriched ? (
                      <View style={styles.pendingRow}>
                        <ActivityIndicator size="small" color={colors.muted} />
                        <Text style={styles.pendingText}>tłumaczę i opisuję…</Text>
                      </View>
                    ) : null}
                    {item.menu_description_translated && item.menu_description_translated.trim() ? (
                      <Text style={styles.menuDesc}>„{item.menu_description_translated.trim()}"</Text>
                    ) : null}
                    {item.source_text && item.source_text.trim() && item.source_text.trim() !== item.original.trim() ? (
                      <Text style={styles.sourceText}>📄 {item.source_text}</Text>
                    ) : null}
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
                  onSearchMore={() => onSearchMorePhotos(si, ii)}
                />
              </Pressable>
            );
          })}
        </View>
        );
      })}

      {/* Podgląd zdjęć w aplikacji (swipe lewo/prawo w obrębie dania) */}
      <Lightbox state={preview} onClose={() => setPreview(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  restaurantHeader: { marginBottom: 20 },
  restaurantName: { fontSize: 26, fontWeight: "800", color: colors.accent },
  restaurantAddress: { fontSize: 14, color: colors.muted, marginTop: 2 },
  notesBlock: { backgroundColor: colors.accent + "14", borderRadius: 12, borderWidth: 1, borderColor: colors.accent + "33", padding: 12, marginBottom: 18 },
  notesTitle: { fontSize: 13, fontWeight: "800", color: colors.accent, marginBottom: 6 },
  noteRow: { flexDirection: "row", gap: 8, alignItems: "flex-start", marginTop: 4 },
  noteIcon: { fontSize: 15, marginTop: 1 },
  noteText: { fontSize: 14, color: colors.text, lineHeight: 19 },
  noteOriginal: { fontSize: 12, color: colors.muted, fontStyle: "italic", marginTop: 1 },
  section: { marginBottom: 24 },
  // Nagłówek sekcji — klikalny (zwija/rozwija grupę).
  sectionHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 6 },
  sectionChevron: { fontSize: 15, color: colors.accent, width: 16, marginTop: 6 },
  sectionHeaderText: { flex: 1 },
  sectionCount: { fontSize: 14, fontWeight: "600", color: colors.muted },
  sectionTitle: { fontSize: 22, fontWeight: "700", color: colors.accent },
  sectionOriginal: { fontSize: 13, color: colors.muted, marginBottom: 4, fontStyle: "italic" },
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
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  itemName: { fontSize: 17, fontWeight: "700", color: colors.text, flex: 1 },
  // flexShrink:0 + maxWidth → cena nie zjada miejsca nazwie (długie/nietypowe ceny
  // zawijają się do 2 linii zamiast spychać nazwę w wąską kolumnę). textAlign do prawej.
  price: { fontSize: 16, fontWeight: "700", color: colors.text, flexShrink: 0, maxWidth: 120, textAlign: "right" },
  original: { fontSize: 13, color: colors.muted, marginTop: 2, fontStyle: "italic" },
  // Warianty cenowe (rozmiary) — pigułki pod nazwą; etykieta + cena.
  variantsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  variantPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.badgeBg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  variantLabel: { fontSize: 12, color: colors.muted },
  variantPrice: { fontSize: 12, fontWeight: "800", color: colors.text },
  // Plakietka ograniczenia czasowego sekcji (menu dnia / weekend / sezon).
  availBadge: { alignSelf: "flex-start", backgroundColor: "#f6e0c0", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, marginTop: 3 },
  availText: { fontSize: 12, color: "#8a5a1a", fontWeight: "700" },
  pendingRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  pendingText: { fontSize: 12, color: colors.muted, fontStyle: "italic" },
  menuDesc: { fontSize: 13, color: colors.text, marginTop: 4, lineHeight: 18, fontStyle: "italic" },
  sourceText: { fontSize: 11, color: colors.muted, marginTop: 3, lineHeight: 15, opacity: 0.85 },
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
  debugBtn: { fontSize: 11, color: colors.muted, fontWeight: "700", marginTop: 10 },
  debugBox: { marginTop: 6, backgroundColor: colors.bg, borderRadius: 8, padding: 8, borderWidth: 1, borderColor: colors.badgeBg },
  debugLine: { fontSize: 11, color: colors.text, marginBottom: 2 },
  debugHdr: { fontSize: 11, color: colors.muted, fontWeight: "700", marginTop: 4, marginBottom: 2 },
  debugStep: { fontSize: 11, color: colors.muted, marginBottom: 1 },
  debugCand: { fontSize: 10, color: colors.muted, marginLeft: 12, opacity: 0.85 },
  venueOk: { color: "#2E7D32", opacity: 1, marginLeft: 20 },
  venueNo: { color: colors.error, opacity: 0.9, marginLeft: 20 },
  debugDim: { fontSize: 11, color: colors.muted, marginTop: 4, fontStyle: "italic" },
  photoStrip: { marginBottom: 6 },
  dishPhotoWrap: { marginRight: 8, position: "relative" },
  dishPhoto: { width: 150, height: 110, borderRadius: 10, backgroundColor: colors.badgeBg },
  morePhotos: { width: 100, height: 110, borderRadius: 10, backgroundColor: colors.badgeBg, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.muted, borderStyle: "dashed" },
  morePhotosGlyph: { fontSize: 22, opacity: 0.6 },
  morePhotosText: { fontSize: 11, fontWeight: "700", color: colors.muted, textAlign: "center", marginTop: 2 },
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
  dishPhotoRejected: { opacity: 0.45 },
  rejectedBadge: { position: "absolute", bottom: 22, left: 6, backgroundColor: "rgba(179,38,30,0.92)", borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2 },
  rejectedBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800" },
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
