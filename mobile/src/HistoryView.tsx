// Lista zapisanych skanów — historia menu, do której można wrócić bez ponownego skanu.
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { SavedScan } from "./storage";
import { MODEL_OPTIONS } from "./types";
import { colors } from "./theme";
import { CachedImage } from "./CachedImage";
import { placePhotoUrl } from "./api";

/** Krótki opis modeli skanu do wiersza: jedna etykieta, a przy mieszanych „+N”. */
function modelSummary(scan: SavedScan): string {
  const label = (id?: string) => MODEL_OPTIONS.find((o) => o.id === id)?.label ?? id ?? "—";
  const m = scan.models;
  if (!m) return label(scan.model);
  const uniq = new Set([m.scan, m.describe, m.verify, m.venue]);
  return uniq.size === 1 ? label(m.scan) : `${label(m.scan)} +${uniq.size - 1}`;
}

/** Miniaturka do wiersza: zdjęcie lokalu → albo pierwsze zdjęcie dania → albo nic. */
function thumbForScan(scan: SavedScan): { uri?: string; remoteUrl?: string } | null {
  const r = scan.restaurant;
  if (r?.photoUris?.[0]) {
    return { uri: r.photoUris[0], remoteUrl: r.photoNames?.[0] ? placePhotoUrl(r.photoNames[0], 300) : undefined };
  }
  if (r?.photoNames?.[0]) {
    const u = placePhotoUrl(r.photoNames[0], 300);
    return { uri: u, remoteUrl: u };
  }
  for (const s of scan.menu.sections) {
    for (const it of s.items) {
      if (it.photos?.[0]) return { uri: it.photos[0].url, remoteUrl: it.photos[0].remoteUrl };
    }
  }
  return null;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("pl-PL", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function itemCount(scan: SavedScan): number {
  return scan.menu.sections.reduce((n, s) => n + s.items.length, 0);
}

function formatCost(scan: SavedScan): string | null {
  const usd = scan.usage?.costUsd;
  if (!usd) return null;
  // poniżej centa pokazujemy więcej miejsc, żeby drobne koszty nie znikały
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function HistoryView({
  scans,
  onOpen,
  onDelete,
  onRename,
}: {
  scans: SavedScan[];
  onOpen: (scan: SavedScan) => void;
  onDelete: (id: string) => void;
  onRename: (scan: SavedScan) => void;
}) {
  if (scans.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyEmoji}>🍝</Text>
        <Text style={styles.emptyText}>Brak zapisanych menu.</Text>
        <Text style={styles.emptySub}>Zeskanowane menu pojawią się tutaj automatycznie.</Text>
      </View>
    );
  }

  return (
    <View>
      {scans.map((scan) => {
        const thumb = thumbForScan(scan);
        return (
        <View key={scan.id} style={styles.row}>
          <Pressable onPress={() => onOpen(scan)}>
            {thumb ? (
              <CachedImage uri={thumb.uri} remoteUrl={thumb.remoteUrl} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbPlaceholder]}>
                <Text style={styles.thumbGlyph}>🍽️</Text>
              </View>
            )}
          </Pressable>
          <Pressable style={styles.rowMain} onPress={() => onOpen(scan)}>
            <Text style={styles.name}>
              {scan.restaurantName || scan.restaurant?.name || "Menu bez nazwy"}
            </Text>
            <Text style={styles.meta}>
              {formatDate(scan.createdAt)} · {itemCount(scan)} pozycji · {scan.targetLang}
              {scan.location ? "  📍" : ""}
            </Text>
            <Text style={styles.meta}>🤖 {modelSummary(scan)}</Text>
            {formatCost(scan) ? (
              <Text style={styles.cost}>💰 {formatCost(scan)}</Text>
            ) : null}
          </Pressable>
          <Pressable style={styles.del} onPress={() => onRename(scan)} hitSlop={8}>
            <Text style={styles.delText}>✏️</Text>
          </Pressable>
          <Pressable style={styles.del} onPress={() => onDelete(scan.id)} hitSlop={8}>
            <Text style={styles.delText}>🗑</Text>
          </Pressable>
        </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  thumb: { width: 52, height: 52, borderRadius: 10, backgroundColor: colors.badgeBg, marginRight: 12 },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center", opacity: 0.5 },
  thumbGlyph: { fontSize: 22, opacity: 0.4 },
  rowMain: { flex: 1 },
  name: { fontSize: 17, fontWeight: "700", color: colors.text },
  meta: { fontSize: 13, color: colors.muted, marginTop: 3 },
  cost: { fontSize: 12, color: colors.muted, marginTop: 3, fontWeight: "600" },
  del: { paddingLeft: 12, paddingVertical: 4 },
  delText: { fontSize: 18 },
  empty: { alignItems: "center", paddingVertical: 64 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 18, fontWeight: "700", color: colors.text },
  emptySub: { fontSize: 14, color: colors.muted, marginTop: 6, textAlign: "center" },
});
