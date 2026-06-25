// Ekran „Logi" — LOKALNE logi TEGO telefonu: co ta apka wysyłała do naszego serwera. TRWAŁE (AsyncStorage,
// przeżywają restart apki), z czyszczeniem. Stan serwera, koszty i błędy z bazy → osobny ekran „Diagnostyka".
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { getCalls, loadCalls, clearCalls, classifyError, type ClientCall } from "./appLog";
import { Icon } from "./Icon";
import { colors } from "./theme";

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return new Date(ts).toISOString().slice(11, 19);
  }
}

export function LogsView() {
  const [calls, setCalls] = useState<ClientCall[]>(getCalls());
  const [onlyErrors, setOnlyErrors] = useState(false);
  useEffect(() => { loadCalls().then(setCalls).catch(() => {}); }, []);

  const phoneCalls = onlyErrors ? calls.filter((c) => !c.ok) : calls;
  const errCount = calls.reduce((n, c) => n + (c.ok ? 0 : 1), 0);
  const since = calls.length ? calls[calls.length - 1]!.ts : null;

  function confirmClear() {
    Alert.alert("Wyczyścić logi?", "Skasuję lokalny log z tego telefonu (na serwerze nic się nie zmienia).", [
      { text: "Anuluj", style: "cancel" },
      { text: "Wyczyść", style: "destructive", onPress: () => void clearCalls().then(() => setCalls([])) },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>Logi</Text>
      <Text style={styles.sub}>
        Co TA apka wysyłała do naszego serwera (trwałe lokalnie). Stan serwera i błędy z bazy → „Diagnostyka".
      </Text>

      <View style={styles.toolbar}>
        <Text style={styles.count}>
          {calls.length} wpis(ów){errCount ? <Text style={styles.errN}> · {errCount} błąd(ów)</Text> : null}
          {since ? ` · od ${fmtTime(since)}` : ""}
        </Text>
        <View style={styles.errToggle}>
          <Text style={styles.errToggleLabel}>tylko błędy</Text>
          <Switch value={onlyErrors} onValueChange={setOnlyErrors} trackColor={{ true: colors.accent }} />
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.btn} onPress={() => setCalls(getCalls())}>
          <Text style={styles.btnText}><Icon name="refresh" size={13} color={colors.accent} /> Odśwież</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnDanger]} onPress={confirmClear} disabled={calls.length === 0}>
          <Text style={[styles.btnText, styles.btnDangerText]}><Icon name="delete" size={13} color={colors.error} /> Wyczyść</Text>
        </Pressable>
      </View>

      {phoneCalls.length === 0 ? (
        <Text style={styles.dim}>
          {onlyErrors ? <>Brak błędów <Icon name="party" size={12} color={colors.muted} /></> : "Brak — zeskanuj coś, by zobaczyć ruch."}
        </Text>
      ) : (
        phoneCalls.map((e, i) => (
          <View key={i} style={styles.entry}>
            <Text style={styles.dot}>{e.ok ? <Icon name="dot" size={11} color="#2e7d32" /> : <Icon name="warn" size={12} color={classifyError(e.detail).color} />}</Text>
            <View style={styles.entryBody}>
              <Text style={styles.entryTop} numberOfLines={1}>
                <Text style={styles.entryTime}>{fmtTime(e.ts)}</Text> · {e.label} · {e.ms}ms
                {e.ok ? "" : ` · ${classifyError(e.detail).label}`}
              </Text>
              {!e.ok && e.detail ? <Text style={styles.entryDetail} numberOfLines={2}>{e.detail}</Text> : null}
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: "800", color: colors.accent, marginBottom: 6 },
  sub: { fontSize: 12, color: colors.muted, marginBottom: 12, lineHeight: 17 },
  toolbar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  count: { fontSize: 12, color: colors.muted, flexShrink: 1 },
  errN: { color: colors.error, fontWeight: "800" },
  errToggle: { flexDirection: "row", alignItems: "center", gap: 4 },
  errToggleLabel: { fontSize: 12, color: colors.muted },
  actions: { flexDirection: "row", gap: 8, marginBottom: 12 },
  btn: { flex: 1, backgroundColor: colors.badgeBg, borderRadius: 10, paddingVertical: 9, alignItems: "center" },
  btnText: { color: colors.accent, fontWeight: "800", fontSize: 13 },
  btnDanger: { backgroundColor: colors.badgeBg },
  btnDangerText: { color: colors.error },
  dim: { color: colors.muted, fontSize: 12, marginTop: 8 },
  entry: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.badgeBg },
  dot: { width: 18, paddingTop: 1 },
  entryBody: { flex: 1 },
  entryTop: { fontSize: 12, color: colors.text },
  entryTime: { color: colors.muted },
  entryDetail: { fontSize: 11, color: colors.error, marginTop: 1 },
});
