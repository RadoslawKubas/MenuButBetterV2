// Zwięzły pasek kosztów na GŁÓWNYM ekranie: ostatnia sesja / dziś / łącznie. „Ostatnia sesja" = live koszt
// bieżącej sesji (x-session-cost), a po restarcie/braku — koszt najnowszego zapisanego skanu. „Dziś/łącznie"
// z serwera (/stats). Kliknięcie → pełny ekran „Koszty". Serwer liczy koszty; apka tylko pokazuje kwoty.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { fetchStats } from "./api";
import { Icon } from "./Icon";
import type { SavedScan } from "./storage";
import { colors } from "./theme";

function fmtUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function CostStrip({
  scans,
  liveSessionCost,
  onPress,
}: {
  scans: SavedScan[];
  liveSessionCost: number;
  onPress?: () => void;
}) {
  const [stats, setStats] = useState<{ today: number; total: number } | null>(null);
  useEffect(() => {
    fetchStats()
      .then((s) => { if (s?.enabled) setStats({ today: s.todayCostUsd ?? 0, total: s.totalCostUsd ?? 0 }); })
      .catch(() => {});
  }, [scans.length]); // odśwież po nowym skanie (przybyła migawka)

  const lastScanCost = scans.length ? (scans.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).usage?.costUsd ?? 0) : 0;
  const lastSession = liveSessionCost > 0 ? liveSessionCost : lastScanCost;

  return (
    <Pressable style={styles.strip} onPress={onPress} disabled={!onPress}>
      <View style={styles.cell}>
        <Text style={styles.lbl}>Ostatnia sesja</Text>
        <Text style={styles.val}>{fmtUsd(lastSession)}</Text>
      </View>
      <View style={styles.sep} />
      <View style={styles.cell}>
        <Text style={styles.lbl}>Dziś</Text>
        <Text style={styles.val}>{stats ? fmtUsd(stats.today) : "—"}</Text>
      </View>
      <View style={styles.sep} />
      <View style={styles.cell}>
        <Text style={styles.lbl}>Łącznie</Text>
        <Text style={styles.val}>{stats ? fmtUsd(stats.total) : "—"}</Text>
      </View>
      {onPress ? <Icon name="forward" size={14} color={colors.muted} style={styles.chev} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.badgeBg,
    paddingVertical: 8,
    paddingHorizontal: 6,
    marginBottom: 12,
  },
  cell: { flex: 1, alignItems: "center" },
  lbl: { fontSize: 10, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.3 },
  val: { fontSize: 15, fontWeight: "800", color: colors.text, marginTop: 2 },
  sep: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: colors.badgeBg, marginVertical: 2 },
  chev: { paddingHorizontal: 4 },
});
