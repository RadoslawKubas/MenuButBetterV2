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
  type DiagTotals,
  type DiagEvent,
} from "./api";
import { getCalls, classifyError } from "./appLog";
import { MODEL_OPTIONS } from "./types";
import { Icon } from "./Icon";
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
  const [stats, setStats] = useState<DiagStats | null>(null);
  const [totals, setTotals] = useState<DiagTotals | null>(null);
  const [events, setEvents] = useState<DiagEvent[]>([]);
  const [exporting, setExporting] = useState(false);

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
      setTotals(diag.totals ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się pobrać diagnostyki.");
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

  // Status serwera „na skróty": czerwony = krytyczne (brak połączenia / budżet → AI wstrzymane),
  // bursztyn = ostrzeżenie (API zwróciło błąd / błąd w ostatniej godzinie), zielony = OK.
  const budgetHit = stats?.dailyBudgetUsd != null && (stats?.todayCostUsd ?? 0) >= stats.dailyBudgetUsd;
  const provFail = providers.some((p) => p.entries[0] && !p.entries[0].ok);
  const recentErr = recentErrors.find((e) => Date.now() - Date.parse(e.at) < 3600_000);
  const status = error
    ? { sev: "red" as const, text: "Brak połączenia z serwerem" }
    : budgetHit
      ? { sev: "red" as const, text: "Budżet dzienny przekroczony — AI wstrzymane do jutra" }
      : provFail
        ? { sev: "amber" as const, text: "Któreś API zwróciło błąd — patrz niżej" }
        : recentErr
          ? { sev: "amber" as const, text: `Błąd w ostatniej godzinie: ${recentErr.detail ?? recentErr.op ?? "?"}` }
          : { sev: "green" as const, text: "Serwer OK" };
  const statusColor = status.sev === "red" ? "#b3261e" : status.sev === "amber" ? "#c77700" : "#2e7d32";

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
    >
      <Text style={styles.title}>Diagnostyka</Text>
      <View style={styles.actions}>
        <Pressable style={styles.action} onPress={exportLogs} disabled={exporting || loading}>
          <Text style={styles.actionText}>{exporting ? "Eksportuję…" : <><Icon name="upload" size={13} color={colors.accent} /> Eksport logów</>}</Text>
        </Pressable>
        <Pressable style={styles.action} onPress={() => void load()} disabled={loading}>
          <Text style={styles.actionText}>{loading ? "Odświeżam…" : <><Icon name="refresh" size={13} color={colors.accent} /> Odśwież</>}</Text>
        </Pressable>
      </View>
      {stats != null || providers.length > 0 || error ? (
        <View style={[styles.statusBox, status.sev === "red" ? styles.statusRed : status.sev === "amber" ? styles.statusAmber : styles.statusGreen]}>
          <Icon name={status.sev === "green" ? "check" : "warn"} size={18} color={statusColor} />
          <Text style={[styles.statusText, { color: statusColor }]}>{status.text}</Text>
        </View>
      ) : null}
      <Text style={styles.hintTop}>Pociągnij w dół, aby odświeżyć.</Text>

      {error ? <Text style={styles.error}><Icon name="warn" size={13} color={colors.error} /> {error}</Text> : null}
      {loading && providers.length === 0 && !stats ? (
        <ActivityIndicator color={colors.accent} style={{ marginVertical: 24 }} />
      ) : null}

      {/* ===================== TRWAŁE (Postgres) ===================== */}
      <Text style={styles.bigSection}><Icon name="package" size={15} color={colors.text} /> Dane trwałe (przeżywają redeploy)</Text>

      {stats?.enabled ? (
        <>
          <View style={styles.box}>
            <Text style={styles.boxTitle}><Icon name="chartLine" size={14} color={colors.accent} /> Podsumowanie</Text>
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

          {/* Ostatnie błędy (trwałe). */}
          <View style={styles.box}>
            <Text style={styles.boxTitle}><Icon name="warn" size={14} color={colors.error} /> Ostatnie błędy</Text>
            {recentErrors.length === 0 ? (
              <Text style={styles.dim}>Brak błędów <Icon name="party" size={13} color={colors.muted} /></Text>
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
              <Text style={styles.boxTitle}><Icon name="clock" size={14} color={colors.accent} /> Ostatnia aktywność</Text>
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
      <Text style={styles.bigSection}><Icon name="web" size={15} color={colors.text} /> API serwera — bieżąca sesja</Text>
      <Text style={styles.sub}>Liczby zerują się po redeployu/restarcie serwera. Dotknij serwis, by zobaczyć log odpowiedzi.</Text>

      {/* Łączny koszt AI tej sesji. */}
      {providers.some((p) => p.costUsd > 0) ? (
        <View style={styles.costBox}>
          <Text style={styles.costBig}><Icon name="cost" size={14} color={colors.accent} /> Koszt AI (sesja): {fmtUsd(providers.reduce((n, p) => n + p.costUsd, 0))}</Text>
          <Text style={styles.costSub}>
            {fmtTok(providers.reduce((n, p) => n + p.inputTokens, 0))} in ·{" "}
            {fmtTok(providers.reduce((n, p) => n + p.outputTokens, 0))} out
          </Text>
        </View>
      ) : null}

      {/* Ruch danych tej sesji — egress (wysłane) jest płatny na Railway. */}
      {providers.some((p) => p.bytesSent > 0 || p.bytesRecv > 0) ? (
        <View style={styles.costBox}>
          <Text style={styles.costBig}>
            <Icon name="signal" size={14} color={colors.accent} /> Ruch danych (sesja): {fmtUsd(totals?.dataCostUsd ?? 0)}
          </Text>
          <Text style={styles.costSub}>
            <Icon name="upload" size={12} color={colors.muted} /> wysłane {fmtBytes(providers.reduce((n, p) => n + p.bytesSent, 0))} ·{" "}
            <Icon name="download" size={12} color={colors.muted} /> odebrane {fmtBytes(providers.reduce((n, p) => n + p.bytesRecv, 0))}
            {totals?.egressUsdPerGB ? `  ·  egress $${totals.egressUsdPerGB}/GB` : ""}
          </Text>
          {totals?.grandTotalUsd != null ? (
            <Text style={[styles.costSub, { fontWeight: "800", color: colors.text, marginTop: 4 }]}>
              Σ łącznie (AI + transfer): {fmtUsd(totals.grandTotalUsd)}
            </Text>
          ) : null}
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
                  <Icon name="dot" size={10} color={failing ? "#b3261e" : p.total > 0 ? "#2e7d32" : colors.muted} />{" "}
                  {p.label}
                </Text>
                <View style={styles.tags}>
                  {p.paid ? <Text style={[styles.tag, styles.tagPaid]}>płatne</Text> : null}
                  <Text style={[styles.tag, p.configured ? styles.tagOn : styles.tagOff]}>
                    {p.configured ? <><Icon name="check" size={10} color="#2e7d32" /> klucz</> : "brak klucza"}
                  </Text>
                </View>
              </View>

              {kind ? (
                <View style={[styles.errBanner, { borderColor: kind.color }]}>
                  <Text style={[styles.errBannerText, { color: kind.color }]}>
                    <Icon name="warn" size={12} color={kind.color} /> Ostatnie zapytanie: {kind.label}
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
                  <Icon name="numeric" size={12} color={colors.muted} /> {fmtTok(p.inputTokens)} in · {fmtTok(p.outputTokens)} out · <Icon name="cost" size={12} color={colors.muted} /> {fmtUsd(p.costUsd)}
                </Text>
              ) : null}
              {p.bytesSent > 0 || p.bytesRecv > 0 ? (
                <Text style={styles.tokens}>
                  <Icon name="signal" size={12} color={colors.muted} /> <Icon name="upload" size={12} color={colors.muted} /> {fmtBytes(p.bytesSent)} · <Icon name="download" size={12} color={colors.muted} /> {fmtBytes(p.bytesRecv)}
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
                      <Text style={styles.dot}>{e.ok ? <Icon name="dot" size={11} color="#2e7d32" /> : <Icon name="warn" size={12} color={classifyError(e.detail).color} />}</Text>
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

  statusBox: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, borderWidth: 1.5, paddingVertical: 12, paddingHorizontal: 12, marginVertical: 8 },
  statusGreen: { borderColor: "#2e7d32", backgroundColor: "#eef7ee" },
  statusAmber: { borderColor: "#c77700", backgroundColor: "#fdf6ea" },
  statusRed: { borderColor: "#b3261e", backgroundColor: "#fdf2f2" },
  statusText: { fontSize: 15, fontWeight: "800", flexShrink: 1 },

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
