// Ekran „Koszty" — zużycie/koszty TEJ instancji apki (ten telefon), liczone LOKALNIE z historii zapisanych skanów
// (każdy skan trzyma usage.costUsd/tokeny ustawione przez serwer z x-session-cost). NIE bierzemy nic z /stats
// serwera (tam suma WSZYSTKICH instalacji). Sekcje: ostatnia sesja, dziś, łącznie (koszt/skany/dania/śr./tokeny),
// trend dzienny. Rozbicie per‑operacja/model i dzienny budżet to dane serwerowe (globalne) — tu ich świadomie nie ma.
import { ScrollView, StyleSheet, Text, View } from "react-native";
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
// Lokalny (strefa urządzenia) klucz dnia „YYYY-MM-DD" z epoch ms.
function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// „2026-06-25" → „25.06". Bieżący/wczorajszy dzień (lokalnie) podpisujemy słownie.
function fmtDay(day: string): string {
  const today = localDay(Date.now());
  if (day === today) return "dziś";
  if (day === localDay(Date.now() - 86_400_000)) return "wczoraj";
  const [, mm, dd] = day.split("-");
  return `${dd}.${mm}`;
}

export function PricingView({ scans }: { scans: SavedScan[] }) {
  // Ostatnia sesja = koszt NAJNOWSZEGO zapisanego skanu (serwer ustawił go z x-session-cost).
  const lastScan = scans.length ? scans.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)) : null;
  const lastCost = lastScan?.usage?.costUsd ?? 0;

  // Wszystko poniżej = suma po skanach TEGO telefonu.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = scans.reduce((a, s) => a + (s.createdAt >= startOfToday.getTime() ? (s.usage?.costUsd ?? 0) : 0), 0);
  const totalCost = scans.reduce((a, s) => a + (s.usage?.costUsd ?? 0), 0);
  const totalScans = scans.length;
  const totalDishes = scans.reduce((a, s) => a + (s.menu?.sections?.reduce((b, sec) => b + (sec.items?.length ?? 0), 0) ?? 0), 0);
  const totalIn = scans.reduce((a, s) => a + (s.usage?.inputTokens ?? 0), 0);
  const totalOut = scans.reduce((a, s) => a + (s.usage?.outputTokens ?? 0), 0);
  const avgPerScan = totalScans > 0 ? totalCost / totalScans : 0;
  const since = scans.length ? localDay(Math.min(...scans.map((s) => s.createdAt))) : null;

  // Trend dzienny: grupuj skany po LOKALNYM dniu, ostatnie 14.
  const byDayMap = new Map<string, { cost: number; scans: number }>();
  for (const s of scans) {
    const k = localDay(s.createdAt);
    const e = byDayMap.get(k) ?? { cost: 0, scans: 0 };
    e.cost += s.usage?.costUsd ?? 0;
    e.scans += 1;
    byDayMap.set(k, e);
  }
  const days = [...byDayMap.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14);
  const maxDayCost = Math.max(0.0001, ...days.map((d) => d.cost));

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Koszty</Text>
      <Text style={styles.sub}>Zużycie TEGO telefonu — suma z zapisanych skanów (serwer policzył koszt każdego). To podgląd tej instancji, nie cennik ani suma wszystkich użytkowników.</Text>

      {!lastScan ? (
        <Text style={styles.dim}>Brak skanów na tym telefonie.</Text>
      ) : (
        <>
          {/* Ostatnia sesja. */}
          <View style={styles.box}>
            <Text style={styles.boxTitle}><Icon name="flask" size={14} color={colors.accent} /> Ostatnia sesja</Text>
            <View style={styles.bigRow}>
              <Text style={styles.big}>{fmtUsd(lastCost)}</Text>
              <Text style={styles.bigSub} numberOfLines={1}>
                {lastScan.menu?.restaurant_name || "skan"} · {fmtAgo(lastScan.createdAt)}
              </Text>
            </View>
          </View>

          {/* Dziś. */}
          <View style={styles.box}>
            <Text style={styles.boxTitle}><Icon name="calendar" size={14} color={colors.accent} /> Dziś</Text>
            <View style={styles.bigRow}>
              <Text style={styles.big}>{fmtUsd(today)}</Text>
            </View>
          </View>

          {/* Łącznie. */}
          <Text style={styles.section}>Łącznie{since ? ` (od ${fmtDay(since)})` : ""}</Text>
          <View style={styles.box}>
            <View style={styles.statGrid}>
              <View style={styles.statCell}><Text style={styles.statNum}>{fmtUsd(totalCost)}</Text><Text style={styles.statLbl}>koszt</Text></View>
              <View style={styles.statCell}><Text style={styles.statNum}>{totalScans}</Text><Text style={styles.statLbl}>skany</Text></View>
              <View style={styles.statCell}><Text style={styles.statNum}>{totalDishes}</Text><Text style={styles.statLbl}>dania</Text></View>
              <View style={styles.statCell}><Text style={styles.statNum}>{fmtUsd(avgPerScan)}</Text><Text style={styles.statLbl}>śr./skan</Text></View>
            </View>
            <Text style={styles.tokens}>tokeny: {fmtTok(totalIn)} in · {fmtTok(totalOut)} out</Text>
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
                      <View style={[styles.dayBarFill, { width: `${Math.max(2, (d.cost / maxDayCost) * 100)}%` }]} />
                    </View>
                    <Text style={styles.dayVal}>{fmtUsd(d.cost)}</Text>
                    <Text style={styles.dayScans}>{d.scans}×</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}

          <Text style={styles.footnote}>
            Rozbicie per‑operacja/model i dzienny budżet to dane SERWERA (wszystkie instalacje) — tu ich nie ma. Cennik modeli/API jest w LAB.
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
  boxTitle: { fontSize: 13, fontWeight: "800", color: colors.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 },
  bigRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10 },
  big: { fontSize: 26, fontWeight: "800", color: colors.text },
  bigSub: { fontSize: 12, color: colors.muted, flexShrink: 1, textAlign: "right" },
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
  footnote: { fontSize: 11, color: colors.muted, marginTop: 14, lineHeight: 16 },
});
