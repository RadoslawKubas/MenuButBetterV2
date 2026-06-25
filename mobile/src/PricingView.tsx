// Ekran „Koszty" — realne ZUŻYCIE/koszty z serwera (serwer liczy koszt każdego zapytania i agreguje;
// apka tylko pokazuje kwoty — NIE trzyma cennika, ten jest w LAB). Sekcje: ostatnia sesja (lokalnie, z
// ostatniego skanu), dziś + budżet, łącznie, trend dzienny, gdzie idą pieniądze (per operacja/model).
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { fetchStats, type DiagStats } from "./api";
import { Icon } from "./Icon";
import type { SavedScan } from "./storage";
import { colors } from "./theme";

function fmtUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}
function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s temu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min temu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h temu`;
  return `${Math.floor(h / 24)} d temu`;
}
// „2026-06-25" → „25.06". Bieżący/wczorajszy dzień podpisujemy słownie.
function fmtDay(day: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (day === today) return "dziś";
  const d = new Date(today); d.setDate(d.getDate() - 1);
  if (day === d.toISOString().slice(0, 10)) return "wczoraj";
  const [, mm, dd] = day.split("-");
  return `${dd}.${mm}`;
}
// Czytelne nazwy operacji (op z eventów serwera) — reszta pokazywana surowo.
const OP_LABELS: Record<string, string> = {
  scan: "Skan (struktura)",
  structure: "Skan (struktura)",
  enrich: "Tłumaczenia + opisy",
  "dish-photos": "Zdjęcia dań",
  "dish-info": "Długie opisy dań",
  "venue-photos": "Zdjęcia z lokalu",
  peek: "Szybki podgląd",
};

export function PricingView({ scans }: { scans: SavedScan[] }) {
  const [stats, setStats] = useState<DiagStats | null>(null);
  useEffect(() => {
    fetchStats().then(setStats).catch(() => {});
  }, []);

  // Ostatnia sesja = koszt NAJNOWSZEGO zapisanego skanu (serwer ustawił go z x-session-cost).
  const lastScan = scans.length ? scans.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)) : null;
  const lastCost = lastScan?.usage?.costUsd ?? 0;

  const today = stats?.todayCostUsd ?? 0;
  const budget = stats?.dailyBudgetUsd;
  const overBudget = budget != null && today >= budget;
  const totalCost = stats?.totalCostUsd ?? 0;
  const totalScans = stats?.totalScans ?? 0;
  const avgPerScan = totalScans > 0 ? totalCost / totalScans : 0;
  const days = (stats?.byDay ?? []).slice(0, 14);
  const maxDayCost = Math.max(0.0001, ...days.map((d) => d.cost ?? 0));
  const ops = (stats?.byOp ?? []).filter((o) => o.cost > 0).slice(0, 8);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Koszty</Text>
      <Text style={styles.sub}>Realne zużycie z serwera — serwer liczy koszt każdego zapytania i sumuje. To podgląd, nie cennik.</Text>

      {/* Ostatnia sesja (lokalnie). */}
      {lastScan ? (
        <View style={styles.box}>
          <Text style={styles.boxTitle}><Icon name="flask" size={14} color={colors.accent} /> Ostatnia sesja</Text>
          <View style={styles.bigRow}>
            <Text style={styles.big}>{fmtUsd(lastCost)}</Text>
            <Text style={styles.bigSub} numberOfLines={1}>
              {lastScan.menu?.restaurant_name || "skan"} · {fmtAgo(lastScan.createdAt)}
            </Text>
          </View>
        </View>
      ) : null}

      {stats == null ? (
        <Text style={styles.dim}>Wczytuję…</Text>
      ) : !stats.enabled ? (
        <Text style={styles.dim}>Statystyki serwera niedostępne (brak bazy).</Text>
      ) : (
        <>
          {/* Dziś + budżet. */}
          <View style={[styles.box, overBudget && styles.boxAlert]}>
            <Text style={styles.boxTitle}><Icon name="calendar" size={14} color={colors.accent} /> Dziś</Text>
            <View style={styles.bigRow}>
              <Text style={styles.big}>{fmtUsd(today)}</Text>
              <Text style={styles.bigSub}>{budget != null ? `budżet ${fmtUsd(budget)}` : "budżet nieustawiony"}</Text>
            </View>
            {budget != null ? (
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${Math.min(100, (today / budget) * 100)}%` }, overBudget && styles.barOver]} />
              </View>
            ) : null}
            {overBudget ? <Text style={styles.alertText}><Icon name="cancel" size={12} color={colors.error} /> Budżet przekroczony — AI wstrzymane do jutra.</Text> : null}
          </View>

          {/* Łącznie. */}
          <Text style={styles.section}>Łącznie{stats.since ? ` (od ${fmtDay(stats.since.slice(0, 10))})` : ""}</Text>
          <View style={styles.box}>
            <View style={styles.statGrid}>
              <View style={styles.statCell}><Text style={styles.statNum}>{fmtUsd(totalCost)}</Text><Text style={styles.statLbl}>koszt</Text></View>
              <View style={styles.statCell}><Text style={styles.statNum}>{totalScans}</Text><Text style={styles.statLbl}>skany</Text></View>
              <View style={styles.statCell}><Text style={styles.statNum}>{stats.totalDishes ?? 0}</Text><Text style={styles.statLbl}>dania</Text></View>
              <View style={styles.statCell}><Text style={styles.statNum}>{fmtUsd(avgPerScan)}</Text><Text style={styles.statLbl}>śr./skan</Text></View>
            </View>
            <Text style={styles.tokens}>
              tokeny: {fmtTok(stats.totalInputTokens ?? 0)} in · {fmtTok(stats.totalOutputTokens ?? 0)} out
            </Text>
          </View>

          {/* Trend dzienny (koszt/dzień). */}
          {days.length ? (
            <>
              <Text style={styles.section}>Trend dzienny</Text>
              <View style={styles.box}>
                {days.map((d) => (
                  <View key={d.day} style={styles.dayRow}>
                    <Text style={styles.dayLbl}>{fmtDay(d.day)}</Text>
                    <View style={styles.dayBarTrack}>
                      <View style={[styles.dayBarFill, { width: `${Math.max(2, ((d.cost ?? 0) / maxDayCost) * 100)}%` }]} />
                    </View>
                    <Text style={styles.dayVal}>{fmtUsd(d.cost ?? 0)}</Text>
                    <Text style={styles.dayScans}>{d.scans}×</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}

          {/* Gdzie idą pieniądze — per operacja. */}
          {ops.length ? (
            <>
              <Text style={styles.section}>Gdzie idą pieniądze</Text>
              <View style={styles.box}>
                {ops.map((o) => (
                  <View key={o.op ?? "?"} style={styles.row}>
                    <Text style={styles.rowName} numberOfLines={1}>{(o.op && OP_LABELS[o.op]) || o.op || "—"}</Text>
                    <Text style={styles.rowVal}>{fmtUsd(o.cost)}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}

          <Text style={styles.footnote}>
            Cennik modeli/API i konfiguracja stawek są w LAB. Dzienny budżet ustawiasz na serwerze (DAILY_BUDGET_USD).
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.accent, marginBottom: 4 },
  sub: { fontSize: 12, color: colors.muted, marginBottom: 14, lineHeight: 17 },
  dim: { fontSize: 13, color: colors.muted, marginTop: 16 },
  section: { fontSize: 13, fontWeight: "800", color: colors.muted, marginTop: 16, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  box: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.badgeBg },
  boxAlert: { borderColor: colors.error, borderWidth: 1.5 },
  boxTitle: { fontSize: 13, fontWeight: "800", color: colors.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 },
  bigRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10 },
  big: { fontSize: 26, fontWeight: "800", color: colors.text },
  bigSub: { fontSize: 12, color: colors.muted, flexShrink: 1, textAlign: "right" },
  barTrack: { height: 6, borderRadius: 999, backgroundColor: colors.badgeBg, marginTop: 8, overflow: "hidden" },
  barFill: { height: 6, borderRadius: 999, backgroundColor: colors.accent },
  barOver: { backgroundColor: colors.error },
  alertText: { fontSize: 13, color: colors.error, fontWeight: "800", marginTop: 6 },
  statGrid: { flexDirection: "row", flexWrap: "wrap" },
  statCell: { width: "25%", alignItems: "center", paddingVertical: 2 },
  statNum: { fontSize: 16, fontWeight: "800", color: colors.text },
  statLbl: { fontSize: 11, color: colors.muted, marginTop: 1 },
  tokens: { fontSize: 11, color: colors.muted, marginTop: 8, textAlign: "center" },
  dayRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 },
  dayLbl: { fontSize: 12, color: colors.muted, width: 48 },
  dayBarTrack: { flex: 1, height: 8, borderRadius: 999, backgroundColor: colors.badgeBg, overflow: "hidden" },
  dayBarFill: { height: 8, borderRadius: 999, backgroundColor: colors.accent },
  dayVal: { fontSize: 12, color: colors.text, fontWeight: "700", width: 56, textAlign: "right" },
  dayScans: { fontSize: 11, color: colors.muted, width: 28, textAlign: "right" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4, gap: 10 },
  rowName: { fontSize: 14, color: colors.text, fontWeight: "600", flexShrink: 1 },
  rowVal: { fontSize: 13, color: colors.text, fontWeight: "700" },
  footnote: { fontSize: 11, color: colors.muted, marginTop: 14, lineHeight: 16 },
});
