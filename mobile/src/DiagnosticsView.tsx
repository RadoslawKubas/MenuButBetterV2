// Ekran „Diagnostyka": dwie warstwy danych —
//  • TRWAŁE (Postgres, przeżywa redeploy): statystyki, koszt per model/operacja, trend,
//    ostatnie błędy, feed aktywności.
//  • BIEŻĄCA SESJA serwera (in‑memory, zeruje się po redeployu): karty per API + drill‑in.
// Na dole log wywołań NASZEGO API z telefonu (co apka wysyłała).
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  fetchDiagnostics,
  fetchStats,
  fetchEvents,
  API_BASE,
  type DiagProvider,
  type DiagStats,
  type DiagEvent,
} from "./api";
import { getCalls, classifyError, type ClientCall } from "./appLog";
import { MODEL_OPTIONS } from "./types";
import { colors } from "./theme";

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return new Date(ts).toISOString().slice(11, 19);
  }
}

// Czas względny „X temu" — czytelniejsze niż goła godzina przy świeżym ruchu.
function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s temu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min temu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h temu`;
  return `${Math.floor(h / 24)} d temu`;
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function fmtUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

// Ładna etykieta modelu (z rejestru) — fallback do surowego id.
function modelLabel(id: string | null): string {
  if (!id) return "—";
  return MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

// Przyjazna nazwa operacji.
const OP_LABELS: Record<string, string> = {
  scan: "Skan menu",
  "dish-info": "Opisy dań",
  "dish-photos": "Zdjęcia dań",
  "venue-photos": "Zdjęcia z lokalu",
};
function opLabel(op: string | null): string {
  return op ? OP_LABELS[op] ?? op : "—";
}

// Krótki kontekst zdarzenia z pola data (nazwa dania / liczba pozycji).
function eventHint(e: DiagEvent): string {
  const d = e.data ?? {};
  if (typeof d.dish === "string") return d.dish;
  if (typeof d.items === "number") return `${d.items} pozycji`;
  return "";
}

export function DiagnosticsView() {
  const [providers, setProviders] = useState<DiagProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [calls, setCalls] = useState<ClientCall[]>(getCalls());
  const [stats, setStats] = useState<DiagStats | null>(null);
  const [events, setEvents] = useState<DiagEvent[]>([]);
  const [exporting, setExporting] = useState(false);
  const [onlyErrors, setOnlyErrors] = useState(false);

  // Eksport WSZYSTKICH logów do pliku JSON (statystyki + wpisy per API z serwera oraz
  // log wywołań z telefonu) i arkusz udostępniania — do wysłania na debug.
  async function exportLogs() {
    setExporting(true);
    try {
      let provs = providers;
      let diagError: string | null = null;
      try {
        provs = (await fetchDiagnostics()).providers;
        setProviders(provs);
      } catch (e) {
        diagError = e instanceof Error ? e.message : "fetchDiagnostics failed";
      }
      const persistentStats = await fetchStats().catch(() => null);
      const persistentEvents = await fetchEvents(1000).catch(() => []);
      const payload = {
        format: "menubutbetter.logs",
        version: 1,
        exportedAt: Date.now(),
        apiBase: API_BASE,
        diagError,
        serverProviders: provs,
        clientCalls: getCalls(),
        persistentStats,
        persistentEvents,
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
      const [diag] = await Promise.all([
        fetchDiagnostics(),
        fetchStats().then(setStats).catch(() => setStats(null)),
        fetchEvents(200).then(setEvents).catch(() => setEvents([])),
      ]);
      setProviders(diag.providers);
      setCalls(getCalls());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się pobrać diagnostyki.");
      setCalls(getCalls());
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  useEffect(() => {
    void load();
  }, []);

  const recentErrors = stats?.recentErrors ?? [];
  const activity = events.filter((e) => e.type !== "error").slice(0, 15);
  const phoneCalls = onlyErrors ? calls.filter((c) => !c.ok) : calls;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
    >
      <Text style={styles.title}>Diagnostyka</Text>
      <View style={styles.actions}>
        <Pressable style={styles.action} onPress={exportLogs} disabled={exporting || loading}>
          <Text style={styles.actionText}>{exporting ? "Eksportuję…" : "⬆︎ Eksport logów"}</Text>
        </Pressable>
        <Pressable style={styles.action} onPress={() => void load()} disabled={loading}>
          <Text style={styles.actionText}>{loading ? "Odświeżam…" : "↻ Odśwież"}</Text>
        </Pressable>
      </View>
      <Text style={styles.hintTop}>Pociągnij w dół, aby odświeżyć.</Text>

      {error ? <Text style={styles.error}>⚠️ {error}</Text> : null}
      {loading && providers.length === 0 && !stats ? (
        <ActivityIndicator color={colors.accent} style={{ marginVertical: 24 }} />
      ) : null}

      {/* ===================== TRWAŁE (Postgres) ===================== */}
      <Text style={styles.bigSection}>📦 Dane trwałe (przeżywają redeploy)</Text>

      {stats?.enabled ? (
        <>
          <View style={styles.box}>
            <Text style={styles.boxTitle}>📈 Podsumowanie</Text>
            <Text style={styles.line}>
              Skany: {stats.totalScans ?? 0} · Dania: {stats.totalDishes ?? 0} ·{" "}
              <Text style={(stats.errors ?? 0) > 0 ? styles.errN : undefined}>Błędy: {stats.errors ?? 0}</Text>
            </Text>
            <Text style={styles.line}>
              Koszt łączny: {fmtUsd(stats.totalCostUsd ?? 0)} · {fmtTok(stats.totalInputTokens ?? 0)} in ·{" "}
              {fmtTok(stats.totalOutputTokens ?? 0)} out
            </Text>
            {stats.since ? <Text style={styles.since}>od {stats.since.slice(0, 10)}</Text> : null}
          </View>

          {/* Koszt per MODEL — wprost do porównań (pełny koszt: skan+opisy+weryfikacja+venue). */}
          {(stats.byModel ?? []).length > 0 ? (
            <View style={styles.box}>
              <Text style={styles.boxTitle}>💸 Koszt per model</Text>
              {(stats.byModel ?? []).map((m) => (
                <View key={m.model ?? "?"} style={styles.statRow}>
                  <Text style={styles.statName} numberOfLines={1}>{modelLabel(m.model)}</Text>
                  <Text style={styles.statVal}>
                    {fmtUsd(m.cost)} · {m.calls}× · {fmtTok(m.inputTokens)}/{fmtTok(m.outputTokens)} tok
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Koszt per OPERACJA — gdzie idą pieniądze. */}
          {(stats.byOp ?? []).length > 0 ? (
            <View style={styles.box}>
              <Text style={styles.boxTitle}>🧮 Koszt per operacja</Text>
              {(stats.byOp ?? []).map((o) => (
                <View key={o.op ?? "?"} style={styles.statRow}>
                  <Text style={styles.statName} numberOfLines={1}>{opLabel(o.op)}</Text>
                  <Text style={styles.statVal}>
                    {fmtUsd(o.cost)} · {o.calls}× · {fmtTok(o.inputTokens)}/{fmtTok(o.outputTokens)} tok
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Trend dzienny (ostatnie 7 dni). */}
          {(stats.byDay ?? []).length > 0 ? (
            <View style={styles.box}>
              <Text style={styles.boxTitle}>📅 Skany / dzień</Text>
              {(stats.byDay ?? []).slice(0, 7).map((d) => (
                <View key={d.day} style={styles.statRow}>
                  <Text style={styles.statName}>{d.day}</Text>
                  <Text style={styles.statVal}>{d.scans} skan(y)</Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Ostatnie błędy (trwałe). */}
          <View style={styles.box}>
            <Text style={styles.boxTitle}>🔴 Ostatnie błędy</Text>
            {recentErrors.length === 0 ? (
              <Text style={styles.dim}>Brak błędów 🎉</Text>
            ) : (
              recentErrors.map((e, i) => (
                <View key={i} style={styles.errRow}>
                  <Text style={styles.errMeta}>
                    {fmtAgo(Date.parse(e.at))} · {e.provider ?? "?"} · {opLabel(e.op)}
                  </Text>
                  {e.detail ? <Text style={styles.errDetail} numberOfLines={2}>{e.detail}</Text> : null}
                </View>
              ))
            )}
          </View>

          {/* Feed ostatniej aktywności (trwały). */}
          {activity.length > 0 ? (
            <View style={styles.box}>
              <Text style={styles.boxTitle}>🕒 Ostatnia aktywność</Text>
              {activity.map((e, i) => {
                const hint = eventHint(e);
                return (
                  <View key={i} style={styles.actRow}>
                    <Text style={styles.actMeta} numberOfLines={1}>
                      {fmtAgo(Date.parse(e.created_at))} · {opLabel(e.op)} · {modelLabel(e.model)}
                      {hint ? ` · ${hint}` : ""}
                    </Text>
                    <Text style={styles.actCost}>{fmtUsd(e.cost_usd ?? 0)}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </>
      ) : (
        <Text style={styles.dim}>
          Trwałe statystyki wyłączone (brak bazy). Działa tylko bieżąca sesja poniżej.
        </Text>
      )}

      {/* ===================== BIEŻĄCA SESJA serwera ===================== */}
      <Text style={styles.bigSection}>🌐 API serwera — bieżąca sesja</Text>
      <Text style={styles.sub}>Liczby zerują się po redeployu/restarcie serwera. Dotknij serwis, by zobaczyć log odpowiedzi.</Text>

      {/* Łączny koszt AI tej sesji. */}
      {providers.some((p) => p.costUsd > 0) ? (
        <View style={styles.costBox}>
          <Text style={styles.costBig}>💰 Koszt AI (sesja): {fmtUsd(providers.reduce((n, p) => n + p.costUsd, 0))}</Text>
          <Text style={styles.costSub}>
            {fmtTok(providers.reduce((n, p) => n + p.inputTokens, 0))} in ·{" "}
            {fmtTok(providers.reduce((n, p) => n + p.outputTokens, 0))} out
          </Text>
        </View>
      ) : null}

      {/* Ruch danych tej sesji — egress (wysłane) jest płatny na Railway. */}
      {providers.some((p) => p.bytesSent > 0 || p.bytesRecv > 0) ? (
        <View style={styles.costBox}>
          <Text style={styles.costBig}>📡 Ruch danych (sesja)</Text>
          <Text style={styles.costSub}>
            ⬆️ wysłane {fmtBytes(providers.reduce((n, p) => n + p.bytesSent, 0))} ·{" "}
            ⬇️ odebrane {fmtBytes(providers.reduce((n, p) => n + p.bytesRecv, 0))}
          </Text>
        </View>
      ) : null}

      {providers.map((p) => {
        const isOpen = open === p.provider;
        const last = p.entries[0];
        const failing = !!last && !last.ok;
        const kind = failing ? classifyError(last.detail) : null;
        return (
          <View key={p.provider} style={[styles.card, failing && styles.cardErr]}>
            <Pressable onPress={() => setOpen(isOpen ? null : p.provider)}>
              <View style={styles.cardTop}>
                <Text style={styles.provider}>
                  {failing ? "🔴 " : p.total > 0 ? "🟢 " : "⚪️ "}
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
                <Text style={styles.dim}>{p.lastAt ? fmtAgo(p.lastAt) : "—"}</Text>
              </View>
              {p.costUsd > 0 || p.inputTokens > 0 ? (
                <Text style={styles.tokens}>
                  🔢 {fmtTok(p.inputTokens)} in · {fmtTok(p.outputTokens)} out · 💰 {fmtUsd(p.costUsd)}
                </Text>
              ) : null}
              {p.bytesSent > 0 || p.bytesRecv > 0 ? (
                <Text style={styles.tokens}>
                  📡 ⬆️ {fmtBytes(p.bytesSent)} · ⬇️ {fmtBytes(p.bytesRecv)}
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

      {/* ===================== Wywołania z telefonu ===================== */}
      <View style={styles.callsHeader}>
        <Text style={styles.bigSection}>📱 Wywołania z telefonu</Text>
        <View style={styles.errToggle}>
          <Text style={styles.errToggleLabel}>tylko błędy</Text>
          <Switch value={onlyErrors} onValueChange={setOnlyErrors} />
        </View>
      </View>
      <Text style={styles.sub}>Co apka wysyłała do naszego serwera (ta sesja).</Text>
      {phoneCalls.length === 0 ? (
        <Text style={styles.dim}>{onlyErrors ? "Brak błędów w tej sesji 🎉" : "Brak — zeskanuj coś, by zobaczyć ruch."}</Text>
      ) : (
        phoneCalls.map((e, i) => (
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
  title: { fontSize: 22, fontWeight: "800", color: colors.accent, marginBottom: 10 },
  actions: { flexDirection: "row", gap: 8 },
  action: {
    flex: 1,
    backgroundColor: colors.badgeBg,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  actionText: { color: colors.accent, fontWeight: "800", fontSize: 14 },
  hintTop: { fontSize: 11, color: colors.muted, marginTop: 6, marginBottom: 4 },
  bigSection: { fontSize: 16, fontWeight: "800", color: colors.accent, marginTop: 20, marginBottom: 6 },
  sub: { fontSize: 12, color: colors.muted, marginBottom: 8 },
  error: { color: colors.error, marginTop: 8 },

  box: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.badgeBg },
  boxTitle: { fontSize: 14, fontWeight: "800", color: colors.text, marginBottom: 6 },
  line: { fontSize: 13, color: colors.text, fontWeight: "600", marginTop: 2 },
  since: { fontSize: 11, color: colors.muted, marginTop: 4, fontStyle: "italic" },

  statRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 3, gap: 10 },
  statName: { fontSize: 13, color: colors.text, fontWeight: "600", flexShrink: 1 },
  statVal: { fontSize: 12, color: colors.muted, fontWeight: "600", flexShrink: 0 },

  errRow: { paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.badgeBg },
  errMeta: { fontSize: 12, color: colors.error, fontWeight: "700" },
  errDetail: { fontSize: 11, color: colors.muted, marginTop: 1 },

  actRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 3, gap: 10 },
  actMeta: { fontSize: 12, color: colors.text, flexShrink: 1 },
  actCost: { fontSize: 12, color: colors.muted, fontWeight: "700", flexShrink: 0 },

  costBox: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.accent },
  costBig: { fontSize: 16, fontWeight: "800", color: colors.accent },
  costSub: { fontSize: 12, color: colors.muted, marginTop: 2 },
  tokens: { fontSize: 12, color: colors.text, fontWeight: "600", marginTop: 6 },

  card: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.badgeBg },
  cardErr: { borderColor: "#b3261e", borderWidth: 1.5, backgroundColor: "#fdf2f2" },
  errBanner: { marginTop: 8, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, backgroundColor: "#fff" },
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

  callsHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  errToggle: { flexDirection: "row", alignItems: "center", gap: 4 },
  errToggleLabel: { fontSize: 12, color: colors.muted },
});
