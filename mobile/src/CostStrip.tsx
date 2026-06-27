// Zwięzły pasek kosztów na GŁÓWNYM ekranie: ostatnia sesja / dziś / łącznie. WSZYSTKO liczone LOKALNIE z historii
// skanów TEJ instancji apki (nie z serwera — serwer sumuje WSZYSTKIE instalacje). „Ostatnia sesja" = live koszt
// bieżącej sesji (x-session-cost), a po restarcie/braku — koszt najnowszego zapisanego skanu. „Dziś/łącznie" =
// suma usage.costUsd zapisanych skanów (dziś = createdAt ≥ początek dnia urządzenia). Kliknięcie → ekran „Koszty".
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "./Icon";
import type { SavedScan, CostLedgerEntry } from "./storage";
import { listDeletedCost } from "./storage";
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
  // Rejestr kosztu SKASOWANYCH skanów — koszt to wydatek, kasowanie menu NIE zeruje sum. Przeładuj, gdy zmienia się
  // lista skanów (np. po skasowaniu wpisu). [[recordDeletedCost]]
  const [deleted, setDeleted] = useState<CostLedgerEntry[]>([]);
  useEffect(() => { listDeletedCost().then(setDeleted).catch(() => {}); }, [scans]);

  const lastScanCost = scans.length ? (scans.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).usage?.costUsd ?? 0) : 0;
  const lastSession = liveSessionCost > 0 ? liveSessionCost : lastScanCost;
  // „Dziś" i „Łącznie" = TYLKO ta instancja (żywe skany + skasowane z rejestru), NIE serwer (= wszystkie instalacje).
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const total = scans.reduce((a, s) => a + (s.usage?.costUsd ?? 0), 0) + deleted.reduce((a, d) => a + d.costUsd, 0);
  const today = scans.reduce((a, s) => a + (s.createdAt >= startOfToday.getTime() ? (s.usage?.costUsd ?? 0) : 0), 0)
    + deleted.reduce((a, d) => a + (d.createdAt >= startOfToday.getTime() ? d.costUsd : 0), 0);

  return (
    <Pressable style={styles.strip} onPress={onPress} disabled={!onPress}>
      <View style={styles.cell}>
        <Text style={styles.lbl}>Ostatnia sesja</Text>
        <Text style={styles.val}>{fmtUsd(lastSession)}</Text>
      </View>
      <View style={styles.sep} />
      <View style={styles.cell}>
        <Text style={styles.lbl}>Dziś</Text>
        <Text style={styles.val}>{fmtUsd(today)}</Text>
      </View>
      <View style={styles.sep} />
      <View style={styles.cell}>
        <Text style={styles.lbl}>Łącznie</Text>
        <Text style={styles.val}>{fmtUsd(total)}</Text>
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
