// Ekran „Diagnostyka": lista zewnętrznych API których serwer bezpośrednio używa
// (liczby zapytań, ok/błędy, ostatni błąd) + drill‑in w log ostatnich odpowiedzi.
// Na dole log wywołań NASZEGO API z telefonu (co apka wysyłała i czy przeszło).
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { fetchDiagnostics, fetchStats, fetchEvents, API_BASE, type DiagProvider, type DiagStats } from "./api";
import { getCalls, classifyError, type ClientCall } from "./appLog";
import { colors } from "./theme";

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return new Date(ts).toISOString().slice(11, 19);
  }
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function fmtUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function DiagnosticsView() {
  const [providers, setProviders] = useState<DiagProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [calls, setCalls] = useState<ClientCall[]>(getCalls());
  const [stats, setStats] = useState<DiagStats | null>(null);
  const [exporting, setExporting] = useState(false);

  // Eksport WSZYSTKICH logów do pliku JSON (statystyki + wpisy per API z serwera oraz
  // log wywołań z telefonu) i arkusz udostępniania — do wysłania na debug.
  async function exportLogs() {
    setExporting(true);
    try {
      // Pobierz najświeższą diagnostykę (fallback: bieżący stan, gdy sieć padnie).
      let provs = providers;
      let diagError: string | null = null;
      try {
        provs = (await fetchDiagnostics()).providers;
        setProviders(provs);
      } catch (e) {
        diagError = e instanceof Error ? e.message : "fetchDiagnostics failed";
      }
      // Trwałe statystyki + surowe zdarzenia (gdy DB włączona) — best-effort.
      const stats = await fetchStats().catch(() => null);
      const events = await fetchEvents(1000).catch(() => []);
      const payload = {
        format: "menubutbetter.logs",
        version: 1,
        exportedAt: Date.now(),
        apiBase: API_BASE,
        diagError,
        serverProviders: provs,
        clientCalls: getCalls(),
        persistentStats: stats,
        persistentEvents: events,
      };
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const file = new File(Paths.cache, `mbb-logs-${stamp}.json`);
      if (file.exists) file.delete();
      file.create();
      file.write(JSON.stringify(payload, null, 2));
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Eksport gotowy", `Plik zapisany: ${file.uri}`);
        return;
      }
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/json",
        dialogTitle: "Wyślij logi (JSON)",
        UTI: "public.json",
      });
    } catch (e) {
      Alert.alert("Nie udało się wyeksportować logów", e instanceof Error ? e.message : "Spróbuj ponownie.");
    } finally {
      setExporting(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { providers } = await fetchDiagnostics();
      setProviders(providers);
      setCalls(getCalls());
      fetchStats().then(setStats).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się pobrać diagnostyki.");
      setCalls(getCalls());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.h1} numberOfLines={1}>API serwera</Text>
        <View style={styles.headerBtns}>
          <Pressable style={styles.refresh} onPress={exportLogs} disabled={exporting || loading}>
            <Text style={styles.refreshText}>{exporting ? "…" : "⬆︎ Logi"}</Text>
          </Pressable>
          <Pressable style={styles.refresh} onPress={load} disabled={loading}>
            <Text style={styles.refreshText}>{loading ? "…" : "↻ Odśwież"}</Text>
          </Pressable>
        </View>
      </View>

      {error ? <Text style={styles.error}>⚠️ {error}</Text> : null}
      {loading && providers.length === 0 ? (
        <ActivityIndicator color={colors.accent} style={{ marginVertical: 24 }} />
      ) : null}

      {/* Trwałe statystyki (Postgres) — przeżywają redeploy, w przeciwieństwie do liczb wyżej. */}
      {stats?.enabled ? (
        <View style={styles.statsBox}>
          <Text style={styles.statsTitle}>📈 Statystyki (trwałe)</Text>
          <Text style={styles.statsLine}>
            Skany: {stats.totalScans ?? 0} · Dania: {stats.totalDishes ?? 0} · Błędy: {stats.errors ?? 0}
          </Text>
          <Text style={styles.statsLine}>
            Koszt łączny: {fmtUsd(stats.totalCostUsd ?? 0)} ·{" "}
            {fmtTok(stats.totalInputTokens ?? 0)} in · {fmtTok(stats.totalOutputTokens ?? 0)} out
          </Text>
          {(stats.byModel ?? []).map((m) => (
            <Text key={m.model ?? "?"} style={styles.statsSub}>
              • {m.model ?? "—"}: {m.scans} skan(y) · {fmtUsd(m.cost)}
            </Text>
          ))}
          {stats.since ? <Text style={styles.statsSince}>od {stats.since.slice(0, 10)}</Text> : null}
        </View>
      ) : null}

      {/* Łączny koszt AI = to, co realnie kosztuje (tokeny), nie liczba wywołań. */}
      {providers.some((p) => p.costUsd > 0) ? (
        <View style={styles.costBox}>
          <Text style={styles.costBig}>
            💰 Koszt AI: {fmtUsd(providers.reduce((n, p) => n + p.costUsd, 0))}
          </Text>
          <Text style={styles.costSub}>
            {fmtTok(providers.reduce((n, p) => n + p.inputTokens, 0))} in ·{" "}
            {fmtTok(providers.reduce((n, p) => n + p.outputTokens, 0))} out · ta sesja serwera
          </Text>
        </View>
      ) : null}

      {providers.map((p) => {
        const isOpen = open === p.provider;
        // Czy OSTATNIE zapytanie do tego API poszło błędem (≠ „kiedykolwiek był błąd").
        const last = p.entries[0];
        const failing = !!last && !last.ok;
        const kind = failing ? classifyError(last.detail) : null;
        return (
          <View key={p.provider} style={[styles.card, failing && styles.cardErr]}>
            <Pressable onPress={() => setOpen(isOpen ? null : p.provider)}>
              <View style={styles.cardTop}>
                <Text style={styles.provider}>
                  {failing ? "🔴 " : p.total > 0 ? "🟢 " : ""}
                  {p.label}
                </Text>
                <View style={styles.tags}>
                  {p.paid ? <Text style={[styles.tag, styles.tagPaid]}>płatne</Text> : null}
                  <Text style={[styles.tag, p.configured ? styles.tagOn : styles.tagOff]}>
                    {p.configured ? "klucz ✓" : "brak klucza"}
                  </Text>
                </View>
              </View>

              {kind ? (
                <View style={[styles.errBanner, { borderColor: kind.color }]}>
                  <Text style={[styles.errBannerText, { color: kind.color }]}>
                    {kind.icon} Ostatnie zapytanie: {kind.label}
                  </Text>
                </View>
              ) : null}

              <View style={styles.statsRow}>
                <Text style={styles.stat}>
                  Σ {p.total} · <Text style={styles.ok}>ok {p.ok}</Text> ·{" "}
                  <Text style={p.errors > 0 ? styles.errN : styles.dim}>błędy {p.errors}</Text>
                </Text>
                <Text style={styles.dim}>{p.lastAt ? fmtTime(p.lastAt) : "—"}</Text>
              </View>
              {p.costUsd > 0 || p.inputTokens > 0 ? (
                <Text style={styles.tokens}>
                  🔢 {fmtTok(p.inputTokens)} in · {fmtTok(p.outputTokens)} out · 💰 {fmtUsd(p.costUsd)}
                </Text>
              ) : null}
              {p.lastError ? (
                <Text style={styles.lastErr} numberOfLines={2}>
                  {p.lastError}
                </Text>
              ) : null}
            </Pressable>

            {isOpen ? (
              <View style={styles.entries}>
                {p.entries.length === 0 ? (
                  <Text style={styles.dim}>Brak zapytań w tej sesji serwera.</Text>
                ) : (
                  p.entries.map((e, i) => (
                    <View key={i} style={styles.entry}>
                      <Text style={styles.dot}>{e.ok ? "🟢" : classifyError(e.detail).icon}</Text>
                      <Text style={styles.entryTime}>{fmtTime(e.ts)}</Text>
                      <Text style={styles.entryOp} numberOfLines={1}>
                        {e.op} · {e.ms}ms
                        {e.ok ? "" : ` · ${classifyError(e.detail).label}`}
                        {e.detail ? ` · ${e.detail}` : ""}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            ) : null}
          </View>
        );
      })}

      <Text style={[styles.h1, { marginTop: 20 }]}>Wywołania z telefonu</Text>
      <Text style={styles.sub}>Co apka wysyłała do naszego serwera (ta sesja).</Text>
      {calls.length === 0 ? (
        <Text style={styles.dim}>Brak — zeskanuj coś, by zobaczyć ruch.</Text>
      ) : (
        calls.map((e, i) => (
          <View key={i} style={styles.entry}>
            <Text style={styles.dot}>{e.ok ? "🟢" : classifyError(e.detail).icon}</Text>
            <Text style={styles.entryTime}>{fmtTime(e.ts)}</Text>
            <Text style={styles.entryOp} numberOfLines={1}>
              {e.label} · {e.ms}ms
              {e.ok ? "" : ` · ${classifyError(e.detail).label}`}
              {e.detail ? ` · ${e.detail}` : ""}
            </Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 },
  headerBtns: { flexDirection: "row", gap: 6, flexShrink: 0 },
  h1: { fontSize: 18, fontWeight: "800", color: colors.accent, flexShrink: 1 },
  sub: { fontSize: 12, color: colors.muted, marginBottom: 8 },
  refresh: { backgroundColor: colors.badgeBg, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  refreshText: { color: colors.accent, fontWeight: "700", fontSize: 13 },
  error: { color: colors.error, marginBottom: 8 },
  costBox: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: colors.accent },
  costBig: { fontSize: 18, fontWeight: "800", color: colors.accent },
  costSub: { fontSize: 12, color: colors.muted, marginTop: 2 },
  tokens: { fontSize: 12, color: colors.text, fontWeight: "600", marginTop: 6 },
  statsBox: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: colors.accent },
  statsTitle: { fontSize: 15, fontWeight: "800", color: colors.accent, marginBottom: 4 },
  statsLine: { fontSize: 13, color: colors.text, fontWeight: "600", marginTop: 2 },
  statsSub: { fontSize: 12, color: colors.muted, marginTop: 2 },
  statsSince: { fontSize: 11, color: colors.muted, marginTop: 4, fontStyle: "italic" },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  cardErr: { borderColor: "#b3261e", borderWidth: 1.5, backgroundColor: "#fdf2f2" },
  errBanner: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: "#fff",
  },
  errBannerText: { fontSize: 12, fontWeight: "800" },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  provider: { fontSize: 16, fontWeight: "700", color: colors.text },
  tags: { flexDirection: "row", gap: 6 },
  tag: { fontSize: 10, fontWeight: "800", paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, overflow: "hidden" },
  tagPaid: { backgroundColor: "#f0e0b0", color: "#7a5a1a" },
  tagOn: { backgroundColor: "#d7efd7", color: "#2e7d32" },
  tagOff: { backgroundColor: "#f0d6d6", color: "#b3261e" },
  statsRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  stat: { fontSize: 13, color: colors.text, fontWeight: "600" },
  ok: { color: "#2e7d32" },
  errN: { color: colors.error, fontWeight: "800" },
  dim: { color: colors.muted, fontSize: 12 },
  lastErr: { color: colors.error, fontSize: 12, marginTop: 6 },
  entries: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.badgeBg, paddingTop: 8, gap: 4 },
  entry: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
  dot: { fontSize: 11, width: 18 },
  entryTime: { fontSize: 11, color: colors.muted, width: 64 },
  entryOp: { fontSize: 12, color: colors.text, flex: 1 },
});
