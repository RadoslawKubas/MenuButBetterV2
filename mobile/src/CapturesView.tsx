// Ekran „Tryb testowy" — lista zapisanych migawek skanów (co poszło do serwera).
// Dla każdej: czas, ustawienia, pozycja GPS + locationHint, miniatury zdjęć menu.
// „📥 Wczytaj do skanu" wstawia zdjęcia + podpowiedzi migawki na ekran skanu (bez startu) —
// user może zmienić ustawienia (modele/język) i sam kliknąć „Przetłumacz menu".
import { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Sharing from "expo-sharing";
import {
  listCaptures,
  deleteCapture,
  exportCaptures,
  resolveCaptureUri,
  type ScanCapture,
} from "./captures";
import { Lightbox, type LightboxState } from "./Lightbox";
import { colors } from "./theme";

function fmtWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return new Date(ts).toISOString();
  }
}

function sourceLabel(c: ScanCapture): string {
  if (!c.location) return "bez pozycji";
  if (c.locationSource === "exif") return "EXIF zdjęcia";
  if (c.locationSource === "device") return "GPS telefonu";
  return "—";
}

export function CapturesView({ onReplay }: { onReplay: (c: ScanCapture) => void }) {
  const [captures, setCaptures] = useState<ScanCapture[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Co teraz pakujemy: "all" | id konkretnej migawki | null. Blokuje pozostałe przyciski.
  const [exporting, setExporting] = useState<string | null>(null);
  // Podgląd powiększonych zdjęć menu danej migawki (galeria ze swipe).
  const [preview, setPreview] = useState<LightboxState | null>(null);

  async function load() {
    setCaptures(await listCaptures().catch(() => []));
  }
  useEffect(() => {
    void load();
  }, []);

  // Pakuje ZIP (wszystkie albo wskazane id) i otwiera arkusz udostępniania —
  // żeby wysłać próbki z telefonu (Pliki / AirDrop / mail).
  async function doExport(key: string, ids?: string[]) {
    setExporting(key);
    try {
      const uri = await exportCaptures(ids);
      if (!uri) {
        Alert.alert("Brak migawek", "Nie ma jeszcze nic do wyeksportowania.");
        return;
      }
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Eksport gotowy", `Plik zapisany: ${uri}`);
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: "application/zip",
        dialogTitle: "Wyślij próbki skanów (ZIP)",
        UTI: "public.zip-archive",
      });
    } catch (e) {
      Alert.alert("Nie udało się wyeksportować", e instanceof Error ? e.message : "Spróbuj ponownie.");
    } finally {
      setExporting(null);
    }
  }

  function confirmDelete(c: ScanCapture) {
    Alert.alert("Usunąć migawkę?", "Skasuję zapisane dane i zdjęcia menu tej migawki.", [
      { text: "Anuluj", style: "cancel" },
      {
        text: "Usuń",
        style: "destructive",
        onPress: async () => {
          await deleteCapture(c.id);
          await load();
        },
      },
    ]);
  }

  async function replay(c: ScanCapture) {
    setBusy(c.id);
    try {
      onReplay(c);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Tryb testowy — migawki skanów</Text>
      <Text style={styles.sub}>
        Każdy skan zapisuje tu komplet danych wysłanych do serwera. „Wczytaj do skanu" wstawia
        zestaw na ekran skanu — zmień ustawienia (modele/język) i sam kliknij „Przetłumacz menu",
        by porównać to samo wejście różnymi modelami.
      </Text>

      {captures.length > 0 ? (
        <Pressable
          style={[styles.export, !!exporting && styles.disabled]}
          disabled={!!exporting}
          onPress={() => doExport("all")}
        >
          <Text style={styles.exportText}>
            {exporting === "all" ? "⏳ Pakuję ZIP…" : `⬆︎ Wyeksportuj wszystkie (${captures.length}) do ZIP`}
          </Text>
        </Pressable>
      ) : null}

      {captures.length === 0 ? (
        <Text style={styles.empty}>Brak migawek — zrób skan, a pojawi się tutaj.</Text>
      ) : (
        captures.map((c) => (
          <View key={c.id} style={styles.card}>
            <Text style={styles.when}>🕘 {fmtWhen(c.createdAt)}</Text>

            {c.images.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbRow}>
                {c.images.map((im, i) => (
                  <Pressable
                    key={i}
                    onPress={() =>
                      setPreview({
                        photos: c.images.map((p) => ({ url: resolveCaptureUri(p.path) ?? p.path, source: "menu" })),
                        index: i,
                      })
                    }
                  >
                    <Image source={{ uri: resolveCaptureUri(im.path) }} style={styles.thumb} />
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}

            <View style={styles.metaGrid}>
              <Meta k="Zdjęcia" v={`${c.images.length}`} />
              {c.restaurantHint ? <Meta k="Lokal (hint)" v={c.restaurantHint} /> : null}
              <Meta
                k="GPS"
                v={
                  c.location
                    ? `${c.location.lat.toFixed(5)}, ${c.location.lng.toFixed(5)} (${sourceLabel(c)})`
                    : sourceLabel(c)
                }
              />
              {c.locationHint ? <Meta k="Kontekst" v={c.locationHint} /> : null}
              <Meta
                k="Lokalizacja"
                v={`EXIF ${c.useExifLocation ? "✓" : "✗"} · GPS ${c.useDeviceLocation ? "✓" : "✗"}`}
              />
            </View>

            <View style={styles.actions}>
              <Pressable
                style={[styles.replay, busy === c.id && styles.disabled]}
                disabled={busy === c.id}
                onPress={() => replay(c)}
              >
                <Text style={styles.replayText}>📥 Wczytaj do skanu</Text>
              </Pressable>
              <Pressable
                style={[styles.iconAction, !!exporting && styles.disabled]}
                disabled={!!exporting}
                onPress={() => doExport(c.id, [c.id])}
              >
                <Text style={styles.iconActionText}>{exporting === c.id ? "⏳" : "⬆︎"}</Text>
              </Pressable>
              <Pressable style={styles.iconAction} onPress={() => confirmDelete(c)}>
                <Text style={styles.iconActionText}>🗑</Text>
              </Pressable>
            </View>
          </View>
        ))
      )}
    </ScrollView>
    <Lightbox state={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.meta}>
      <Text style={styles.metaK}>{k}</Text>
      <Text style={styles.metaV}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  h1: { fontSize: 18, fontWeight: "800", color: colors.accent },
  sub: { fontSize: 12, color: colors.muted, marginTop: 4, marginBottom: 12, lineHeight: 17 },
  empty: { color: colors.muted, fontSize: 14, marginTop: 24, textAlign: "center" },
  export: {
    backgroundColor: colors.badgeBg,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: 14,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  exportText: { color: colors.accent, fontWeight: "800", fontSize: 14 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  when: { fontSize: 14, fontWeight: "800", color: colors.text },
  thumbRow: { flexDirection: "row", marginTop: 10 },
  thumb: { width: 64, height: 80, borderRadius: 8, marginRight: 8, backgroundColor: colors.badgeBg },
  metaGrid: { marginTop: 10, gap: 4 },
  meta: { flexDirection: "row", alignItems: "flex-start" },
  metaK: { width: 96, fontSize: 12, color: colors.muted, fontWeight: "700" },
  metaV: { flex: 1, fontSize: 12, color: colors.text },
  actions: { flexDirection: "row", gap: 10, marginTop: 12, alignItems: "center" },
  replay: { flex: 1, backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  replayText: { color: colors.buttonText, fontWeight: "800", fontSize: 14 },
  disabled: { opacity: 0.4 },
  iconAction: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.badgeBg,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  iconActionText: { fontSize: 16 },
});
