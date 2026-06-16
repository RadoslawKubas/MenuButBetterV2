// Ekran „Ustawienia": wybór modelu AI OSOBNO dla każdego miejsca użycia (skan / opisy /
// weryfikacja zdjęć / dopasowanie zdjęć z lokalu) + wejścia do Diagnostyki i Migawek.
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MODEL_OPTIONS, MODEL_ROLES, type ModelId, type ModelRole } from "./types";
import { colors } from "./theme";

export function SettingsView({
  models,
  onChangeModel,
  onOpenDiagnostics,
  onOpenCaptures,
  capturesCount,
}: {
  models: Record<ModelRole, ModelId>;
  onChangeModel: (role: ModelRole, model: ModelId) => void;
  onOpenDiagnostics: () => void;
  onOpenCaptures: () => void;
  capturesCount: number;
}) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Ustawienia</Text>

      <Text style={styles.section}>Model AI per miejsce</Text>
      <Text style={styles.sub}>
        Każdy etap może używać innego modelu — wygodne do porównań jakość/koszt (Claude vs GPT).
      </Text>

      {MODEL_ROLES.map(({ role, label, hint }) => (
        <View key={role} style={styles.roleCard}>
          <Text style={styles.roleLabel}>{label}</Text>
          <Text style={styles.roleHint}>{hint}</Text>
          <View style={styles.chips}>
            {MODEL_OPTIONS.map((m) => {
              const active = models[role] === m.id;
              return (
                <Pressable
                  key={m.id}
                  onPress={() => onChangeModel(role, m.id)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{m.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}

      <Text style={styles.section}>Narzędzia</Text>
      <Pressable style={styles.toolBtn} onPress={onOpenCaptures}>
        <Text style={styles.toolText}>🧪 Migawki (tryb testowy){capturesCount ? ` · ${capturesCount}` : ""}</Text>
        <Text style={styles.toolChevron}>›</Text>
      </Pressable>
      <Pressable style={styles.toolBtn} onPress={onOpenDiagnostics}>
        <Text style={styles.toolText}>📊 Diagnostyka i logi</Text>
        <Text style={styles.toolChevron}>›</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.accent, marginBottom: 8 },
  section: { fontSize: 13, fontWeight: "800", color: colors.muted, marginTop: 16, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  sub: { fontSize: 12, color: colors.muted, marginBottom: 10, lineHeight: 17 },
  roleCard: { backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.badgeBg },
  roleLabel: { fontSize: 15, fontWeight: "700", color: colors.text },
  roleHint: { fontSize: 12, color: colors.muted, marginTop: 2, marginBottom: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.badgeBg },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontWeight: "600", fontSize: 13 },
  chipTextActive: { color: colors.buttonText },
  toolBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  toolText: { fontSize: 15, fontWeight: "700", color: colors.text },
  toolChevron: { fontSize: 20, color: colors.muted },
});
