// Ekran „Ustawienia": język + wejścia do Narzędzi + informacje techniczne (wersja + numer builda, serwer,
// status kluczy). Modele i Koszty/Limity sterowane teraz z LABu (config runtime na serwerze).
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import Constants from "expo-constants";
import * as Application from "expo-application";
import {
  LANGUAGES,
  PROVIDER_LABELS,
  PROVIDER_DIAG_KEY,
  type ModelProvider,
} from "./types";
import { fetchDiagnostics, API_BASE, isForceFresh, setForceFresh } from "./api";
import { colors } from "./theme";

const PROVIDER_ORDER: ModelProvider[] = ["anthropic", "openai", "google"];

function CostSwitch({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.costRow}>
      <Text style={styles.costLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent }} />
    </View>
  );
}

export function SettingsView({
  targetLang,
  onChangeLang,
  onOpenDiagnostics,
  onOpenCaptures,
  onOpenPricing,
  capturesCount,
}: {
  targetLang: string;
  onChangeLang: (lang: string) => void;
  onOpenDiagnostics: () => void;
  onOpenCaptures: () => void;
  onOpenPricing: () => void;
  capturesCount: number;
}) {
  const [forceFresh, setForceFreshState] = useState(isForceFresh());
  // Status kluczy providerów (z /diagnostics) — by ostrzec przed modelem bez klucza.
  const [configured, setConfigured] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    let alive = true;
    fetchDiagnostics()
      .then((d) => {
        if (!alive) return;
        const map: Record<string, boolean> = {};
        for (const p of d.providers) map[p.provider] = p.configured;
        setConfigured(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Brak danych = nie ostrzegaj (true). Inaczej z mapy.
  function providerOk(prov: ModelProvider): boolean {
    if (!configured) return true;
    return configured[PROVIDER_DIAG_KEY[prov]] ?? true;
  }

  // Wersja + NUMER BUILDA z natywnych wartości (expo-application): buildNo = CFBundleVersion, który realnie
  // rośnie przy każdym buildzie (autoIncrement) — `expoConfig.ios.buildNumber` jest statyczny, stąd dotąd
  // widać było tylko „1.0.0". Fallback do expoConfig, gdyby natywne były null (np. Expo Go / web).
  const appVersion = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "?";
  const buildNo = Application.nativeBuildVersion ?? (Constants.expoConfig?.ios?.buildNumber as string | undefined) ?? null;
  const serverHost = API_BASE.replace(/^https?:\/\//, "");
  const isProd = /railway|up\.app|menubutbetter-production/.test(API_BASE);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Ustawienia</Text>

      <Text style={styles.section}>Język tłumaczenia</Text>
      <View style={styles.chips}>
        {LANGUAGES.map((lang) => {
          const active = targetLang === lang;
          return (
            <Pressable key={lang} onPress={() => onChangeLang(lang)} style={[styles.chip, active && styles.chipActive]}>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{lang}</Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.section}>Modele AI</Text>
      <Text style={styles.sub}>
        Modele dla poszczególnych etapów (skan, opisy, weryfikacja zdjęć…) ustawia się teraz centralnie w
        panelu LAB (config runtime na serwerze) — apka korzysta z aktualnej konfiguracji serwera.
      </Text>

      <Text style={styles.section}>Koszty / limity</Text>
      <Text style={styles.sub}>
        Auto‑dociąganie po skanie (opisy od razu vs na kliknięcie, limit dań) oraz źródła zdjęć i weryfikacja
        są teraz sterowane centralnie z panelu LAB (config runtime na serwerze).
      </Text>

      <Text style={styles.section}>Narzędzia</Text>
      <Pressable style={styles.toolBtn} onPress={onOpenPricing}>
        <Text style={styles.toolText}>💲 Cennik (modele i API)</Text>
        <Text style={styles.toolChevron}>›</Text>
      </Pressable>
      <Pressable style={styles.toolBtn} onPress={onOpenCaptures}>
        <Text style={styles.toolText}>🧪 Migawki (tryb testowy){capturesCount ? ` · ${capturesCount}` : ""}</Text>
        <Text style={styles.toolChevron}>›</Text>
      </Pressable>
      <Pressable style={styles.toolBtn} onPress={onOpenDiagnostics}>
        <Text style={styles.toolText}>📊 Diagnostyka i logi</Text>
        <Text style={styles.toolChevron}>›</Text>
      </Pressable>

      <Text style={styles.section}>Debugowanie</Text>
      <Text style={styles.sub}>
        Tryb bez cache: serwer NIE czyta z cache (generuje wszystko od nowa — skan, opisy, zdjęcia), ale świeży
        wynik nadal zapisuje (cache się odświeża). Do testowania zmian. Zostaw wyłączone na co dzień.
      </Text>
      <View style={styles.roleCard}>
        <CostSwitch
          label="🧪 Wymuś świeży wynik (bez cache)"
          value={forceFresh}
          onChange={(v) => { setForceFreshState(v); void setForceFresh(v); }}
        />
      </View>

      <Text style={styles.section}>Informacje</Text>
      <View style={styles.infoBox}>
        <View style={styles.infoRow}>
          <Text style={styles.infoK}>Wersja</Text>
          <Text style={styles.infoV}>{appVersion}{buildNo ? ` (build ${buildNo})` : ""}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoK}>Serwer</Text>
          <Text style={styles.infoV} numberOfLines={1}>{isProd ? "🌐 produkcja" : "💻 lokalny"} · {serverHost}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoK}>Klucze</Text>
          <Text style={styles.infoV}>
            {PROVIDER_ORDER.map((p) => `${PROVIDER_LABELS[p].split(" ")[0]} ${providerOk(p) ? "✓" : "✗"}`).join(" · ")}
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.accent, marginBottom: 8 },
  section: { fontSize: 13, fontWeight: "800", color: colors.muted, marginTop: 18, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  sub: { fontSize: 12, color: colors.muted, marginBottom: 10, lineHeight: 17 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.badgeBg },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: colors.buttonText },

  preset: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.badgeBg, minWidth: 100 },
  presetActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  presetLabel: { color: colors.text, fontWeight: "800", fontSize: 14 },
  presetDesc: { color: colors.muted, fontSize: 11, marginTop: 1 },
  presetDescActive: { color: colors.buttonText, opacity: 0.85 },
  resetBtn: { marginTop: 10, alignSelf: "flex-start" },
  resetText: { color: colors.accent, fontWeight: "700", fontSize: 13 },

  roleCard: { backgroundColor: colors.card, borderRadius: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.badgeBg, overflow: "hidden" },
  roleHeader: { flexDirection: "row", alignItems: "center", padding: 12, gap: 10 },
  roleHeadMain: { flex: 1 },
  roleLabel: { fontSize: 15, fontWeight: "700", color: colors.text },
  roleHint: { fontSize: 12, color: colors.muted, marginTop: 2 },
  roleCur: { alignItems: "flex-end" },
  roleCurModel: { fontSize: 13, fontWeight: "700", color: colors.accent, maxWidth: 130 },
  roleCurPrice: { fontSize: 11, color: colors.muted },
  chevron: { fontSize: 18, color: colors.muted, width: 16, textAlign: "center" },
  picker: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  provGroup: { marginTop: 4 },
  provLabel: { fontSize: 11, fontWeight: "700", color: colors.muted, marginBottom: 6 },
  modelChip: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.badgeBg, alignItems: "center" },
  modelChipWarn: { borderColor: "#d6a200", borderStyle: "dashed" },
  modelChipText: { color: colors.text, fontWeight: "700", fontSize: 13 },
  modelChipPrice: { color: colors.muted, fontSize: 10, marginTop: 1 },

  costRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6, gap: 10 },
  costLabel: { fontSize: 14, color: colors.text, fontWeight: "600", flexShrink: 1 },
  costLimitLabel: { fontSize: 13, fontWeight: "700", color: colors.muted, marginTop: 10, marginBottom: 8 },
  toolBtn: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.card, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 16, marginBottom: 10, borderWidth: 1, borderColor: colors.badgeBg },
  toolText: { fontSize: 15, fontWeight: "700", color: colors.text },
  toolChevron: { fontSize: 20, color: colors.muted },

  infoBox: { backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.badgeBg },
  infoRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4, gap: 12 },
  infoK: { fontSize: 13, color: colors.muted, fontWeight: "700" },
  infoV: { fontSize: 13, color: colors.text, fontWeight: "600", flexShrink: 1, textAlign: "right" },
});
