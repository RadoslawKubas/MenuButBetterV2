// Ekran „Ustawienia": język + modele AI (szybkie zestawy / osobno per etap, z cenami) +
// wejścia do Narzędzi + informacje techniczne (wersja, serwer, status kluczy, reset).
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import Constants from "expo-constants";
import type { CostPrefs } from "./storage";
import {
  LANGUAGES,
  MODEL_OPTIONS,
  MODEL_ROLES,
  MODEL_PRESETS,
  PROVIDER_LABELS,
  PROVIDER_DIAG_KEY,
  DEFAULT_MODELS,
  allRolesToModel,
  type ModelId,
  type ModelRole,
  type ModelProvider,
} from "./types";
import { fetchDiagnostics, API_BASE, isForceFresh, setForceFresh } from "./api";
import { colors } from "./theme";

const PROVIDER_ORDER: ModelProvider[] = ["anthropic", "openai", "google"];

function priceOf(id: ModelId): string {
  const o = MODEL_OPTIONS.find((m) => m.id === id);
  return o ? `$${o.price.in}/$${o.price.out}` : "";
}

// Pełna mapa ról ustawiona na jeden model (presety / „ustaw wszędzie") — rozszerzalne (MODEL_ROLES).
const allRoles = allRolesToModel;

function CostSwitch({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.costRow}>
      <Text style={styles.costLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent }} />
    </View>
  );
}

export function SettingsView({
  models,
  onChangeModel,
  onSetModels,
  targetLang,
  onChangeLang,
  costPrefs,
  onChangeCostPrefs,
  onOpenDiagnostics,
  onOpenCaptures,
  onOpenPricing,
  capturesCount,
}: {
  models: Record<ModelRole, ModelId>;
  onChangeModel: (role: ModelRole, model: ModelId) => void;
  onSetModels: (models: Record<ModelRole, ModelId>) => void;
  targetLang: string;
  onChangeLang: (lang: string) => void;
  costPrefs: CostPrefs;
  onChangeCostPrefs: (next: CostPrefs) => void;
  onOpenDiagnostics: () => void;
  onOpenCaptures: () => void;
  onOpenPricing: () => void;
  capturesCount: number;
}) {
  const [openRole, setOpenRole] = useState<ModelRole | null>(null);
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

  const allSame = (model: ModelId) => MODEL_ROLES.every(({ role }) => models[role] === model);

  const appVersion = Constants.expoConfig?.version ?? "?";
  const buildNo = (Constants.expoConfig?.ios?.buildNumber as string | undefined) ?? null;
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

      <Text style={styles.section}>Szybkie zestawy</Text>
      <Text style={styles.sub}>Jeden tap ustawia ten model we wszystkich etapach (skan + opisy + zdjęcia).</Text>
      <View style={styles.chips}>
        {MODEL_PRESETS.map((p) => {
          const active = allSame(p.model);
          return (
            <Pressable
              key={p.id}
              onPress={() => onSetModels(allRoles(p.model))}
              style={[styles.preset, active && styles.presetActive]}
            >
              <Text style={[styles.presetLabel, active && styles.chipTextActive]}>{p.label}</Text>
              <Text style={[styles.presetDesc, active && styles.presetDescActive]}>{p.desc}</Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable onPress={() => onSetModels(DEFAULT_MODELS)} style={styles.resetBtn}>
        <Text style={styles.resetText}>↺ Przywróć domyślne</Text>
      </Pressable>

      <Text style={styles.section}>Model osobno per etap</Text>
      <Text style={styles.sub}>Ceny: $ za 1M tokenów (wejście/wyjście). Dotknij etap, by zmienić model.</Text>
      {MODEL_ROLES.map(({ role, label, hint }) => {
        const cur = MODEL_OPTIONS.find((o) => o.id === models[role]);
        const isOpen = openRole === role;
        return (
          <View key={role} style={styles.roleCard}>
            <Pressable style={styles.roleHeader} onPress={() => setOpenRole(isOpen ? null : role)}>
              <View style={styles.roleHeadMain}>
                <Text style={styles.roleLabel}>{label}</Text>
                <Text style={styles.roleHint}>{hint}</Text>
              </View>
              <View style={styles.roleCur}>
                <Text style={styles.roleCurModel} numberOfLines={1}>{cur?.label ?? models[role]}</Text>
                <Text style={styles.roleCurPrice}>{priceOf(models[role])}</Text>
              </View>
              <Text style={styles.chevron}>{isOpen ? "▾" : "›"}</Text>
            </Pressable>

            {isOpen ? (
              <View style={styles.picker}>
                {PROVIDER_ORDER.map((prov) => (
                  <View key={prov} style={styles.provGroup}>
                    <Text style={styles.provLabel}>
                      {PROVIDER_LABELS[prov]}
                      {providerOk(prov) ? "" : " · ⚠ brak klucza"}
                    </Text>
                    <View style={styles.chips}>
                      {MODEL_OPTIONS.filter((o) => o.provider === prov).map((m) => {
                        const active = models[role] === m.id;
                        return (
                          <Pressable
                            key={m.id}
                            onPress={() => onChangeModel(role, m.id)}
                            style={[styles.modelChip, active && styles.chipActive, !providerOk(prov) && styles.modelChipWarn]}
                          >
                            <Text style={[styles.modelChipText, active && styles.chipTextActive]}>{m.label}</Text>
                            <Text style={[styles.modelChipPrice, active && styles.chipTextActive]}>
                              ${m.price.in}/${m.price.out}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        );
      })}

      <Text style={styles.section}>Koszty / limity</Text>
      <Text style={styles.sub}>
        Wyłącza tylko AUTOMATYCZNE dociąganie po skanie. W dane danie zawsze dociągniesz opis/zdjęcia na dotknięcie.
      </Text>
      <View style={styles.roleCard}>
        <CostSwitch
          label="Auto‑opisy dań po skanie"
          value={costPrefs.autoDescriptions}
          onChange={(v) => onChangeCostPrefs({ ...costPrefs, autoDescriptions: v })}
        />
        <CostSwitch
          label="Auto‑zdjęcia poglądowe po skanie"
          value={costPrefs.autoPhotos}
          onChange={(v) => onChangeCostPrefs({ ...costPrefs, autoPhotos: v })}
        />
        <CostSwitch
          label="Auto‑zdjęcia z lokalu (Tier 0)"
          value={costPrefs.autoVenuePhotos}
          onChange={(v) => onChangeCostPrefs({ ...costPrefs, autoVenuePhotos: v })}
        />
        <Text style={styles.costLimitLabel}>Limit dań do auto‑dociągania</Text>
        <View style={styles.chips}>
          {[0, 5, 10, 20].map((n) => {
            const active = costPrefs.autoLimit === n;
            return (
              <Pressable
                key={n}
                onPress={() => onChangeCostPrefs({ ...costPrefs, autoLimit: n })}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{n === 0 ? "wszystkie" : n}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.costLimitLabel}>Zdjęć na partię skanu struktury</Text>
        <Text style={styles.sub}>
          1 = każda strona osobno (granularny postęp). Więcej = model widzi kartki RAZEM → lepsza ciągłość grup
          ciągnących się przez strony. Enrich i tak leci osobno po całości.
        </Text>
        <View style={styles.chips}>
          {[1, 2, 3, 5, 10].map((n) => {
            const active = (costPrefs.batchSize || 1) === n;
            return (
              <Pressable
                key={n}
                onPress={() => onChangeCostPrefs({ ...costPrefs, batchSize: n })}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{n === 10 ? "maks" : n}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

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
