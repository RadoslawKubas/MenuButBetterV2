// Ekran „Ustawienia": język + wejścia do Narzędzi + PODGLĄD ustawień serwera (read-only) + informacje
// techniczne (wersja + numer builda, serwer, status kluczy). Modele, źródła zdjęć, weryfikacja, opisy i cache
// ustawia się CENTRALNIE w panelu LAB (config runtime na serwerze) — apka tylko pokazuje, co serwer ma teraz.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon } from "./Icon";
import Constants from "expo-constants";
import * as Application from "expo-application";
import {
  LANGUAGES,
  PROVIDER_LABELS,
  PROVIDER_DIAG_KEY,
  type ModelProvider,
} from "./types";
import { fetchDiagnostics, fetchServerConfig, API_BASE, type ServerConfigView } from "./api";
import { colors } from "./theme";

const PROVIDER_ORDER: ModelProvider[] = ["anthropic", "openai", "google"];

// Etykiety zgodne z panelem LAB (Config) — żeby podgląd w apce nazywał kroki tak samo.
const MODEL_STEP_LABELS: [string, string][] = [
  ["peek", "Szybki podgląd zdjęcia"],
  ["scan", "Skan struktury menu"],
  ["enrich", "Tłumaczenia + krótkie opisy"],
  ["verify", "Weryfikacja zdjęć (vision)"],
  ["dishInfo", "Długie opisy dań"],
  ["venuePool", "Szeroka pula z lokalu → dania"],
];
const STEP_LABELS: [string, string][] = [
  ["photoSerper", "Zdjęcia — Serper web (generyk)"],
  ["photoSerperPlain", "Zdjęcia — Serper web proste (eksperyment)"],
  ["photoSerperSite", "Zdjęcia — Serper z lokalu: strona www"],
  ["photoSerperPortal", "Zdjęcia — Serper z lokalu: portale"],
  ["photoWikimedia", "Zdjęcia — Wikimedia"],
  ["photoOpenverse", "Zdjęcia — Openverse"],
  ["photoVenue", "Zdjęcia z lokalu — Tier 0 (Google/TA)"],
  ["photoVenuePool", "Zdjęcia z lokalu — szeroka pula"],
  ["verifyPhotos", "Weryfikacja AI zdjęć"],
  ["descriptions", "Długie opisy dań"],
];
const CACHE_LABELS: Record<string, string> = {
  "repr-photos": "zdjęcia poglądowe",
  "dish-info": "opisy dań",
  "vision-url": "werdykty vision",
  "menu-structure": "struktura menu",
  "item-enrich": "wzbogacenie pozycji",
  "venue-match": "dopasowanie zdjęć lokalu",
  "bad-photo": "złe kadry (za słaba jakość)",
};

export function SettingsView({
  targetLang,
  onChangeLang,
  onOpenDiagnostics,
  onOpenLogs,
  onOpenCaptures,
  onOpenPricing,
  capturesCount,
}: {
  targetLang: string;
  onChangeLang: (lang: string) => void;
  onOpenDiagnostics: () => void;
  onOpenLogs: () => void;
  onOpenCaptures: () => void;
  onOpenPricing: () => void;
  capturesCount: number;
}) {
  // Status kluczy providerów (z /diagnostics) — by ostrzec przed modelem bez klucza.
  const [configured, setConfigured] = useState<Record<string, boolean> | null>(null);
  // Podgląd konfiguracji serwera (read-only). null = jeszcze nie wczytano / błąd.
  const [serverCfg, setServerCfg] = useState<ServerConfigView | null>(null);
  const [cfgLoading, setCfgLoading] = useState(true);

  function loadServerCfg() {
    setCfgLoading(true);
    fetchServerConfig()
      .then((c) => setServerCfg(c))
      .catch(() => setServerCfg(null))
      .finally(() => setCfgLoading(false));
  }

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
    loadServerCfg();
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

      <Text style={styles.section}>Narzędzia</Text>
      <Pressable style={styles.toolBtn} onPress={onOpenPricing}>
        <Text style={styles.toolText}><Icon name="chartBar" /> Koszty</Text>
        <Text style={styles.toolChevron}>›</Text>
      </Pressable>
      <Pressable style={styles.toolBtn} onPress={onOpenCaptures}>
        <Text style={styles.toolText}><Icon name="flask" /> Migawki (tryb testowy){capturesCount ? ` · ${capturesCount}` : ""}</Text>
        <Text style={styles.toolChevron}>›</Text>
      </Pressable>
      <Pressable style={styles.toolBtn} onPress={onOpenDiagnostics}>
        <Text style={styles.toolText}><Icon name="signal" /> Diagnostyka (serwer)</Text>
        <Text style={styles.toolChevron}>›</Text>
      </Pressable>
      <Pressable style={styles.toolBtn} onPress={onOpenLogs}>
        <Text style={styles.toolText}><Icon name="note" /> Logi (ten telefon)</Text>
        <Text style={styles.toolChevron}>›</Text>
      </Pressable>

      <View style={styles.cfgHead}>
        <Text style={[styles.section, styles.cfgHeadText]}>Konfiguracja serwera</Text>
        <Pressable onPress={loadServerCfg} hitSlop={8}>
          <Text style={styles.cfgRefresh}>↻ odśwież</Text>
        </Pressable>
      </View>
      <Text style={styles.sub}>
        Podgląd tego, co ustawiono w panelu LAB (Config) i wysłano na serwer. Tu tylko do wglądu — apka stosuje
        aktualną konfigurację serwera, nie zmienia jej.
      </Text>
      {cfgLoading && !serverCfg ? (
        <Text style={styles.cfgMuted}>Wczytywanie…</Text>
      ) : !serverCfg ? (
        <Text style={styles.cfgMuted}>Nie udało się wczytać konfiguracji serwera.</Text>
      ) : (
        <View style={styles.cfgBox}>
          <Text style={styles.cfgGroup}>Modele AI (per krok)</Text>
          {MODEL_STEP_LABELS.map(([key, label]) => (
            <View key={key} style={styles.cfgRow}>
              <Text style={styles.cfgKey}>{label}</Text>
              <Text style={styles.cfgModel} numberOfLines={1}>{serverCfg.models[key] ?? "—"}</Text>
            </View>
          ))}

          <Text style={styles.cfgGroup}>Aktywne kroki</Text>
          {STEP_LABELS.map(([key, label]) => {
            const on = serverCfg.steps[key] !== false;
            return (
              <View key={key} style={styles.cfgRow}>
                <Text style={styles.cfgKey}>{label}</Text>
                <Text style={[styles.cfgVal, on ? styles.cfgOn : styles.cfgOff]}>{on ? "✓ wł." : "✗ wył."}</Text>
              </View>
            );
          })}

          <Text style={styles.cfgGroup}>Odczyt z cache</Text>
          {serverCfg.cacheReadOff.length === 0 ? (
            <Text style={styles.cfgNote}>Wszystkie cache czytane normalnie.</Text>
          ) : (
            <>
              <Text style={styles.cfgNote}>Wyłączony odczyt (regeneracja, ale zapis działa) dla:</Text>
              {serverCfg.cacheReadOff.map((k) => (
                <View key={k} style={styles.cfgRow}>
                  <Text style={styles.cfgKey}>{CACHE_LABELS[k] ?? k}</Text>
                  <Text style={[styles.cfgVal, styles.cfgOff]}>✗ odczyt wył.</Text>
                </View>
              ))}
            </>
          )}

          <Text style={styles.cfgGroup}>Zachowania apki</Text>
          <View style={styles.cfgRow}>
            <Text style={styles.cfgKey}>Auto‑opisy dań po skanie</Text>
            <Text style={[styles.cfgVal, serverCfg.app.autoDescriptions ? styles.cfgOn : styles.cfgOff]}>
              {serverCfg.app.autoDescriptions ? "✓ od razu" : "✗ na kliknięcie"}
            </Text>
          </View>
          <View style={styles.cfgRow}>
            <Text style={styles.cfgKey}>Limit dań do auto‑dociągania zdjęć</Text>
            <Text style={styles.cfgVal}>{serverCfg.app.autoLimit > 0 ? `${serverCfg.app.autoLimit}` : "wszystkie"}</Text>
          </View>
        </View>
      )}

      <Text style={styles.section}>Informacje</Text>
      <View style={styles.infoBox}>
        <View style={styles.infoRow}>
          <Text style={styles.infoK}>Wersja</Text>
          <Text style={styles.infoV}>{appVersion}{buildNo ? ` (build ${buildNo})` : ""}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoK}>Serwer</Text>
          <Text style={styles.infoV} numberOfLines={1}>{isProd ? "produkcja" : "lokalny"} · {serverHost}</Text>
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

  toolBtn: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: colors.card, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 16, marginBottom: 10, borderWidth: 1, borderColor: colors.badgeBg },
  toolText: { fontSize: 15, fontWeight: "700", color: colors.text },
  toolChevron: { fontSize: 20, color: colors.muted },

  // Podgląd konfiguracji serwera (read-only)
  cfgHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18 },
  cfgHeadText: { marginTop: 0, marginBottom: 0 },
  cfgRefresh: { color: colors.accent, fontWeight: "700", fontSize: 13 },
  cfgMuted: { fontSize: 13, color: colors.muted, fontStyle: "italic", marginBottom: 8 },
  cfgBox: { backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.badgeBg },
  cfgGroup: { fontSize: 12, fontWeight: "800", color: colors.muted, marginTop: 12, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 },
  cfgRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 5, gap: 12 },
  cfgKey: { fontSize: 13, color: colors.text, flexShrink: 1 },
  cfgVal: { fontSize: 13, fontWeight: "700", color: colors.text, textAlign: "right" },
  cfgModel: { fontSize: 12, fontWeight: "700", color: colors.accent, maxWidth: 150, textAlign: "right" },
  cfgOn: { color: colors.accent },
  cfgOff: { color: colors.muted },
  cfgNote: { fontSize: 12, color: colors.muted, marginTop: 2, marginBottom: 2, lineHeight: 16 },

  infoBox: { backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.badgeBg },
  infoRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4, gap: 12 },
  infoK: { fontSize: 13, color: colors.muted, fontWeight: "700" },
  infoV: { fontSize: 13, color: colors.text, fontWeight: "600", flexShrink: 1, textAlign: "right" },
});
