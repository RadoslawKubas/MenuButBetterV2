// Strona „Cennik" — szybki podgląd kosztów: modele AI ($/1M tokenów in/out) + inne API
// (zewnętrzne usługi) z orientacyjnym kosztem i statusem (używane / zapas / free). Na górze
// dzisiejszy koszt z serwera (z dziennym budżetem, jeśli ustawiony).
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { MODEL_OPTIONS, PROVIDER_LABELS, type ModelProvider } from "./types";
import { fetchStats, type DiagStats } from "./api";
import { colors } from "./theme";

const PROVIDER_ORDER: ModelProvider[] = ["anthropic", "openai", "google"];

// Inne API (poza modelami AI) — orientacyjne stawki + do czego służą.
const OTHER_APIS: { name: string; cost: string; status: "używane" | "zapas" | "free"; note: string }[] = [
  { name: "Google Places", cost: "~$17 / 1000 (details+photos)", status: "używane", note: "namierzanie lokalu + zdjęcia z Map" },
  { name: "Serper.dev (Google Images)", cost: "~$0.3–1 / 1000", status: "używane", note: "główne źródło zdjęć dań (web)" },
  { name: "TripAdvisor Content", cost: "free tier (~5000/mies.)", status: "używane", note: "oceny + zdjęcia z podpisami (Tier 0)" },
  { name: "Wikimedia Commons", cost: "free", status: "free", note: "zdjęcia poglądowe (fallback)" },
  { name: "Openverse", cost: "free", status: "free", note: "zdjęcia poglądowe (fallback)" },
  { name: "SerpApi (Google Images)", cost: "od $50 / 5000", status: "zapas", note: "rezerwowe źródło zdjęć" },
  { name: "Google CSE", cost: "100/dzień free, dalej $5/1000", status: "zapas", note: "stare konta / opcjonalne" },
];

function fmtUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function PricingView() {
  const [stats, setStats] = useState<DiagStats | null>(null);
  useEffect(() => {
    fetchStats().then(setStats).catch(() => {});
  }, []);

  const today = stats?.todayCostUsd;
  const budget = stats?.dailyBudgetUsd;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Cennik</Text>
      <Text style={styles.sub}>Stawki orientacyjne. Modele liczone per 1M tokenów (wejście / wyjście).</Text>

      {/* Dziś + budżet (z serwera). */}
      {stats?.enabled ? (
        <View style={[styles.box, budget != null && (today ?? 0) >= budget && styles.boxAlert]}>
          <Text style={styles.boxTitle}>💰 Dziś</Text>
          <Text style={styles.boxLine}>
            Wydano: {fmtUsd(today ?? 0)}
            {budget != null ? `  /  budżet ${fmtUsd(budget)}` : "  ·  budżet nieustawiony"}
          </Text>
          {budget != null && (today ?? 0) >= budget ? (
            <Text style={styles.boxAlertText}>⛔ Budżet przekroczony — AI wstrzymane do jutra.</Text>
          ) : null}
        </View>
      ) : null}

      <Text style={styles.section}>Modele AI ($/1M tok · in / out)</Text>
      {PROVIDER_ORDER.map((prov) => (
        <View key={prov} style={styles.box}>
          <Text style={styles.boxTitle}>{PROVIDER_LABELS[prov]}</Text>
          {MODEL_OPTIONS.filter((m) => m.provider === prov).map((m) => (
            <View key={m.id} style={styles.row}>
              <Text style={styles.rowName} numberOfLines={1}>{m.label}</Text>
              <Text style={styles.rowVal}>${m.price.in} / ${m.price.out}</Text>
            </View>
          ))}
        </View>
      ))}

      <Text style={styles.section}>Inne API</Text>
      <View style={styles.box}>
        {OTHER_APIS.map((a) => (
          <View key={a.name} style={styles.apiRow}>
            <View style={styles.apiHead}>
              <Text style={styles.rowName} numberOfLines={1}>{a.name}</Text>
              <Text style={[styles.tag, a.status === "używane" ? styles.tagUsed : a.status === "free" ? styles.tagFree : styles.tagSpare]}>
                {a.status}
              </Text>
            </View>
            <Text style={styles.apiCost}>{a.cost}</Text>
            <Text style={styles.apiNote}>{a.note}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.footnote}>
        Realny koszt skanów śledzisz w Diagnostyce (koszt per model i per operacja). Dzienny budżet
        ustawiasz na serwerze (DAILY_BUDGET_USD).
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.accent, marginBottom: 4 },
  sub: { fontSize: 12, color: colors.muted, marginBottom: 14, lineHeight: 17 },
  section: { fontSize: 13, fontWeight: "800", color: colors.muted, marginTop: 16, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  box: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.badgeBg },
  boxAlert: { borderColor: colors.error, borderWidth: 1.5 },
  boxTitle: { fontSize: 14, fontWeight: "800", color: colors.text, marginBottom: 6 },
  boxLine: { fontSize: 14, color: colors.text, fontWeight: "600" },
  boxAlertText: { fontSize: 13, color: colors.error, fontWeight: "800", marginTop: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 3, gap: 10 },
  rowName: { fontSize: 14, color: colors.text, fontWeight: "600", flexShrink: 1 },
  rowVal: { fontSize: 13, color: colors.muted, fontWeight: "700" },
  apiRow: { paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.badgeBg },
  apiHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  apiCost: { fontSize: 12, color: colors.muted, marginTop: 2 },
  apiNote: { fontSize: 11, color: colors.muted, marginTop: 1, fontStyle: "italic" },
  tag: { fontSize: 10, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden" },
  tagUsed: { backgroundColor: "#d7efd7", color: "#2e7d32" },
  tagSpare: { backgroundColor: "#f0e0b0", color: "#7a5a1a" },
  tagFree: { backgroundColor: colors.badgeBg, color: colors.muted },
  footnote: { fontSize: 11, color: colors.muted, marginTop: 14, lineHeight: 16 },
});
