// Lista zapisanych skanów — historia menu. Dwa tryby (zapamiętywane):
//  • 🏙️ Po mieście: na górze grupa „📍 W pobliżu" (skany blisko aktualnej pozycji), potem
//    grupy per miasto (kolejność wg najnowszego skanu); WEWNĄTRZ grup zawsze po dacie.
//  • 🗓️ Po dacie: płasko, najnowsze górą.
// + wyszukiwarka po nazwie/mieście.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { SavedScan } from "./storage";
import { loadHistoryGrouping, saveHistoryGrouping, type HistoryGrouping } from "./storage";
import { MODEL_OPTIONS, type GeoPoint } from "./types";
import { getCurrentLocation, distanceMeters } from "./location";
import { colors } from "./theme";
import { CachedImage } from "./CachedImage";
import { placePhotoUrl } from "./api";

// Promień grupy „W pobliżu" (m) — sąsiedztwo aktualnej pozycji.
const NEAR_M = 2000;

function modelSummary(scan: SavedScan): string {
  const label = (id?: string) => MODEL_OPTIONS.find((o) => o.id === id)?.label ?? id ?? "—";
  const m = scan.models;
  if (!m) return label(scan.model);
  const uniq = new Set([m.scan, m.describe, m.verify, m.venue]);
  return uniq.size === 1 ? label(m.scan) : `${label(m.scan)} +${uniq.size - 1}`;
}

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
  return new Date(ms).toLocaleDateString("pl-PL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function itemCount(scan: SavedScan): number {
  return scan.menu.sections.reduce((n, s) => n + s.items.length, 0);
}
function formatCost(scan: SavedScan): string | null {
  const usd = scan.usage?.costUsd;
  if (!usd) return null;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
function cityOf(scan: SavedScan): string | null {
  return scan.restaurant?.city || scan.restaurant?.country || null;
}
function fmtDist(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

interface Group {
  key: string;
  label: string;
  scans: SavedScan[];
}

// Buduje grupy z listy POSORTOWANEJ malejąco po dacie: najpierw „W pobliżu", potem miasta
// (kolejność wg najnowszego skanu), na końcu „Bez lokalizacji".
function buildGroups(byDate: SavedScan[], here: GeoPoint | null): Group[] {
  const near: SavedScan[] = [];
  const byCity = new Map<string, SavedScan[]>();
  for (const s of byDate) {
    if (here && s.location && distanceMeters(here, s.location) <= NEAR_M) {
      near.push(s);
      continue;
    }
    const key = cityOf(s) ?? "__none__";
    (byCity.get(key) ?? byCity.set(key, []).get(key)!).push(s);
  }
  const groups: Group[] = [];
  if (near.length) groups.push({ key: "__near__", label: "📍 W pobliżu", scans: near });
  const cityGroups: Group[] = [...byCity.entries()]
    .filter(([k]) => k !== "__none__")
    .map(([k, arr]) => ({ key: k, label: `🏙️ ${k}`, scans: arr }))
    .sort((a, b) => (b.scans[0]?.createdAt ?? 0) - (a.scans[0]?.createdAt ?? 0));
  groups.push(...cityGroups);
  const none = byCity.get("__none__");
  if (none?.length) groups.push({ key: "__none__", label: "📍 Bez lokalizacji", scans: none });
  return groups;
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
  const [mode, setMode] = useState<HistoryGrouping>("city");
  const [here, setHere] = useState<GeoPoint | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    loadHistoryGrouping().then((m) => {
      if (m) setMode(m);
    });
  }, []);
  // W trybie „po mieście" dociągamy pozycję (best-effort) do grupy „W pobliżu".
  useEffect(() => {
    if (mode === "city" && !here) getCurrentLocation().then(setHere).catch(() => {});
  }, [mode, here]);

  function changeMode(m: HistoryGrouping) {
    setMode(m);
    void saveHistoryGrouping(m).catch(() => {});
  }

  function renderRow(scan: SavedScan, distanceM?: number) {
    const thumb = thumbForScan(scan);
    const city = cityOf(scan);
    const loc =
      distanceM != null ? `  📍 ${fmtDist(distanceM)}` : scan.location ? (city ? `  📍 ${city}` : "  📍") : "";
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
          <Text style={styles.name}>{scan.restaurantName || scan.restaurant?.name || "Menu bez nazwy"}</Text>
          <Text style={styles.meta}>
            {formatDate(scan.createdAt)} · {itemCount(scan)} pozycji · {scan.targetLang}
            {loc}
          </Text>
          <Text style={styles.meta}>🤖 {modelSummary(scan)}</Text>
          {formatCost(scan) ? <Text style={styles.cost}>💰 {formatCost(scan)}</Text> : null}
        </Pressable>
        <Pressable style={styles.del} onPress={() => onRename(scan)} hitSlop={8}>
          <Text style={styles.delText}>✏️</Text>
        </Pressable>
        <Pressable style={styles.del} onPress={() => onDelete(scan.id)} hitSlop={8}>
          <Text style={styles.delText}>🗑</Text>
        </Pressable>
      </View>
    );
  }

  if (scans.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyEmoji}>🍝</Text>
        <Text style={styles.emptyText}>Brak zapisanych menu.</Text>
        <Text style={styles.emptySub}>Zeskanowane menu pojawią się tutaj automatycznie.</Text>
      </View>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? scans.filter((s) =>
        `${s.restaurantName ?? ""} ${s.restaurant?.name ?? ""} ${s.restaurant?.city ?? ""} ${s.restaurant?.country ?? ""}`
          .toLowerCase()
          .includes(q),
      )
    : scans;
  const byDate = [...filtered].sort((a, b) => b.createdAt - a.createdAt);

  const header = (
    <>
      <View style={styles.toggleRow}>
        <Pressable
          onPress={() => changeMode("city")}
          style={[styles.toggle, mode === "city" && styles.toggleActive]}
        >
          <Text style={[styles.toggleText, mode === "city" && styles.toggleTextActive]}>🏙️ Po mieście</Text>
        </Pressable>
        <Pressable
          onPress={() => changeMode("date")}
          style={[styles.toggle, mode === "date" && styles.toggleActive]}
        >
          <Text style={[styles.toggleText, mode === "date" && styles.toggleTextActive]}>🗓️ Po dacie</Text>
        </Pressable>
      </View>
      <TextInput
        style={styles.search}
        placeholder="Szukaj po nazwie lub mieście…"
        placeholderTextColor={colors.muted}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
    </>
  );

  if (byDate.length === 0) {
    return (
      <View>
        {header}
        <Text style={styles.noResults}>Brak wyników dla „{query}".</Text>
      </View>
    );
  }

  if (mode === "date") {
    return (
      <View>
        {header}
        {byDate.map((s) => renderRow(s))}
      </View>
    );
  }

  const groups = buildGroups(byDate, here);
  return (
    <View>
      {header}
      {groups.map((g) => (
        <View key={g.key}>
          <Text style={styles.groupHead}>
            {g.label} · {g.scans.length}
          </Text>
          {g.scans.map((s) =>
            renderRow(s, g.key === "__near__" && here && s.location ? distanceMeters(here, s.location) : undefined),
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  toggleRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  toggle: { flex: 1, paddingVertical: 9, borderRadius: 10, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.badgeBg, alignItems: "center" },
  toggleActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleText: { color: colors.text, fontWeight: "700", fontSize: 13 },
  toggleTextActive: { color: colors.buttonText },
  search: {
    backgroundColor: colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.badgeBg,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: colors.text,
    fontSize: 14,
    marginBottom: 12,
  },
  groupHead: { fontSize: 13, fontWeight: "800", color: colors.muted, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 6, marginBottom: 8 },
  noResults: { color: colors.muted, fontSize: 14, marginTop: 24, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, borderRadius: 12, padding: 14, marginBottom: 10 },
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
