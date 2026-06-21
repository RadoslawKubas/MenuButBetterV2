// Ekran „Tryb testowy" — lista zapisanych migawek skanów (WEJŚCIE wysłane do serwera).
// Każda migawka to jedno wejście (zdjęcia + podpowiedzi + lokalizacja). „📥 Wczytaj do skanu"
// wstawia je na ekran skanu (bez startu) — zmieniasz modele/język i sam klikasz „Przetłumacz".
// Każdy taki przebieg dopisuje się do migawki jako URUCHOMIENIE → hub porównań „to samo menu,
// różne modele" (lista przebiegów z modelem/kosztem, każdy do otwarcia w historii).
import { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Sharing from "expo-sharing";
import {
  listCaptures,
  deleteCapture,
  deleteAllCaptures,
  exportCaptures,
  resolveCaptureUri,
  renameCapture,
  captureRuns,
  capturesDiskBytes,
  buildCaptureUpload,
  importCapturesFromZip,
  type ScanCapture,
} from "./captures";
import { uploadSample, fetchSampleStatus, reportError, fetchAppServerSamples, downloadServerSampleZip, deleteServerSample } from "./api";
import type { SavedScan } from "./storage";
import { MODEL_OPTIONS, distinctModels } from "./types";
import { Lightbox, type LightboxState } from "./Lightbox";
import { colors } from "./theme";

function fmtWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return new Date(ts).toISOString();
  }
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s temu`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min temu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h temu`;
  return `${Math.floor(h / 24)} d temu`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return `${n} B`;
}

// Lekki podpis TREŚCI uploadu — zmienia się, gdy zmieni się coś, co poszłoby w paczce na serwer
// (nowy skan/wynik, nazwa, hint, lokalizacja, liczba przebiegów). Do decyzji „czy jest co aktualizować".
const UPLOADED_SIGS_KEY = "mbb.uploadedSigs.v1";
function contentSig(c: ScanCapture): string {
  return `${c.scanId ?? ""}|${c.name ?? ""}|${c.restaurantHint ?? ""}|${c.locationHint ?? ""}|${c.runs?.length ?? 0}`;
}

function sourceLabel(c: ScanCapture): string {
  if (!c.location) return "bez pozycji";
  if (c.locationSource === "exif") return "EXIF zdjęcia";
  if (c.locationSource === "device") return "GPS telefonu";
  return "—";
}

// Krótki opis modeli skanu (mieszane role → „+N”).
function modelSummary(scan: SavedScan): string {
  const label = (id?: string | null) => MODEL_OPTIONS.find((o) => o.id === id)?.label ?? id ?? "—";
  const m = scan.models;
  if (!m) return label(scan.model);
  const uniq = distinctModels(m); // rozszerzalne: z MODEL_ROLES (uwzględnia enrich i przyszłe role)
  return uniq.length <= 1 ? label(m.scan) : `${label(m.scan)} +${uniq.length - 1}`;
}
function itemCount(scan: SavedScan): number {
  return scan.menu.sections.reduce((n, s) => n + s.items.length, 0);
}
function costOf(scan: SavedScan): string | null {
  const u = scan.usage?.costUsd;
  if (!u) return null;
  return u < 0.01 ? `$${u.toFixed(4)}` : `$${u.toFixed(2)}`;
}

export function CapturesView({
  onReplay,
  scans,
  onOpenScan,
}: {
  onReplay: (c: ScanCapture) => void;
  scans: SavedScan[];
  onOpenScan: (scan: SavedScan) => void;
}) {
  const [captures, setCaptures] = useState<ScanCapture[]>([]);
  // Co teraz pakujemy: "all" | id konkretnej migawki | null. Blokuje pozostałe przyciski.
  const [exporting, setExporting] = useState<string | null>(null);
  const [preview, setPreview] = useState<LightboxState | null>(null);
  // Stan migawek na serwerze (po hashu/sygnaturze): na serwerze? zaimportowane do labu?
  const [sampleStatus, setSampleStatus] = useState<Record<string, { onServer: boolean; imported: boolean }>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Podpis treści ostatniego uploadu per sampel (sig→contentSig) → „Aktualizuj" tylko gdy się zmieniło.
  const [uploadedSigs, setUploadedSigs] = useState<Record<string, string>>({});

  // Import sampli z serwera (wypchniętych z labu, target='app'): zaciąga, scala (dedup po sig →
  // aktualizacja, nie duplikat), po czym KASUJE je z serwera (znikają z kolejki).
  async function importFromServer() {
    setImporting(true);
    try {
      const list = await fetchAppServerSamples();
      if (list.length === 0) { Alert.alert("Brak sampli", "Na serwerze nie ma żadnych sampli do zaimportowania."); return; }
      let added = 0, updated = 0, failed = 0;
      for (const s of list) {
        const bytes = await downloadServerSampleZip(s.id).catch(() => null);
        if (!bytes) { failed++; continue; }
        try {
          const r = await importCapturesFromZip(bytes);
          added += r.added; updated += r.updated;
          await deleteServerSample(s.id); // po imporcie znika z serwera
        } catch (e) {
          failed++;
          reportError(`import sampla z serwera: ${(e as Error)?.message ?? "?"}`, { label: "sample-import", context: { id: s.id } });
        }
      }
      await load();
      Alert.alert("Import z serwera", `Dodano ${added}, zaktualizowano ${updated}${failed ? `, błędów ${failed}` : ""}.`);
    } finally { setImporting(false); }
  }

  async function load() {
    const caps = await listCaptures().catch(() => []);
    setCaptures(caps);
    // Znaczniki „na serwerze / zaimportowany" — best-effort (cicho, gdy serwer/baza niedostępne).
    const hashes = caps.map((c) => c.sig || c.id);
    fetchSampleStatus(hashes).then(setSampleStatus).catch(() => {});
  }
  useEffect(() => {
    void load();
    AsyncStorage.getItem(UPLOADED_SIGS_KEY).then((s) => { if (s) setUploadedSigs(JSON.parse(s)); }).catch(() => {});
  }, []);

  async function uploadOne(c: ScanCapture) {
    setUploading(c.id);
    try {
      const pkg = await buildCaptureUpload(c.id);
      if (!pkg) { Alert.alert("Błąd", "Nie udało się spakować migawki."); return; }
      const r = await uploadSample(pkg.hash, pkg.meta, pkg.zipBase64);
      if (!r.ok) {
        reportError(`upload sampla: ${r.error ?? "?"}`, { label: "sample-upload", context: { hash: pkg.hash, bytes: pkg.zipBase64.length } });
        Alert.alert("Wysyłka nieudana", r.error ?? "Spróbuj ponownie.");
        return;
      }
      // Po update sampel jest „świeży" (pending) → status onServer, NIE imported (lab go re-importuje).
      setSampleStatus((prev) => ({ ...prev, [c.sig || c.id]: { onServer: true, imported: false } }));
      // Zapamiętaj podpis treści, którą właśnie wysłaliśmy → „Aktualizuj" pojawi się dopiero po zmianie.
      setUploadedSigs((prev) => {
        const next = { ...prev, [c.sig || c.id]: contentSig(c) };
        AsyncStorage.setItem(UPLOADED_SIGS_KEY, JSON.stringify(next)).catch(() => {});
        return next;
      });
      const title = r.status === "updated" ? "Zaktualizowano" : r.status === "exists" ? "Już na serwerze" : "Wysłano";
      const body = r.status === "updated"
        ? "Zmodyfikowany sampel (nowy wynik) zastąpił poprzedni — zaimportuj ponownie w labie, podmieni wynik."
        : r.status === "exists"
          ? "Identyczny sampel już jest na serwerze (bez zmian)."
          : "Migawka jest na serwerze — zaimportuj ją w labie.";
      Alert.alert(title, body);
    } catch (e) {
      reportError((e as Error)?.message ?? String(e), { stack: (e as Error)?.stack, label: "sample-upload-throw", context: { id: c.id } });
      Alert.alert("Wysyłka nieudana", (e as Error)?.message ?? "Spróbuj ponownie.");
    } finally {
      setUploading(null);
    }
  }

  const scanById = new Map(scans.map((s) => [s.id, s]));

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

  function confirmDeleteAll() {
    Alert.alert("Usunąć wszystkie migawki?", `Skasuję ${captures.length} migawek i ich zdjęcia z dysku.`, [
      { text: "Anuluj", style: "cancel" },
      {
        text: "Usuń wszystkie",
        style: "destructive",
        onPress: async () => {
          await deleteAllCaptures();
          await load();
        },
      },
    ]);
  }

  function promptRename(c: ScanCapture) {
    Alert.prompt(
      "Nazwa migawki",
      "Ułatwia rozpoznanie wśród wielu próbek.",
      async (text) => {
        await renameCapture(c.id, text ?? "");
        await load();
      },
      "plain-text",
      c.name ?? "",
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Tryb testowy — migawki skanów</Text>
        <Text style={styles.sub}>
          Każdy skan zapisuje tu WEJŚCIE wysłane do serwera. „Wczytaj do skanu" wstawia je na ekran
          skanu — zmień modele/język i kliknij „Przetłumacz menu". Każdy przebieg dopisuje się niżej
          jako uruchomienie, więc porównasz to samo menu różnymi modelami.
        </Text>

        <Pressable
          style={[styles.importBtn, importing && styles.disabled]}
          disabled={importing}
          onPress={() => void importFromServer()}
        >
          <Text style={styles.importBtnText}>{importing ? "⏳ Importuję z serwera…" : "⬇️ Importuj sample z serwera"}</Text>
        </Pressable>

        {captures.length > 0 ? (
          <>
            <Pressable
              style={[styles.export, !!exporting && styles.disabled]}
              disabled={!!exporting}
              onPress={() => doExport("all")}
            >
              <Text style={styles.exportText}>
                {exporting === "all" ? "⏳ Pakuję ZIP…" : `⬆︎ Wyeksportuj wszystkie (${captures.length}) do ZIP`}
              </Text>
            </Pressable>
            <View style={styles.toolbar}>
              <Text style={styles.toolbarInfo}>
                {captures.length} migawek · {fmtBytes(capturesDiskBytes(captures))} na dysku
              </Text>
              <Pressable onPress={confirmDeleteAll} hitSlop={6}>
                <Text style={styles.deleteAll}>🗑 Usuń wszystkie</Text>
              </Pressable>
            </View>
          </>
        ) : null}

        {captures.length === 0 ? (
          <Text style={styles.empty}>Brak migawek — zrób skan, a pojawi się tutaj.</Text>
        ) : (
          captures.map((c) => {
            const runs = captureRuns(c);
            return (
              <View key={c.id} style={styles.card}>
                <View style={styles.titleRow}>
                  <View style={styles.titleMain}>
                    <Text style={styles.title} numberOfLines={1}>
                      {c.name || fmtWhen(c.createdAt)}
                    </Text>
                    <Text style={styles.titleSub}>
                      <Text style={c.origin === "server" ? styles.originServer : c.origin === "app" ? styles.originApp : styles.titleSub}>
                        {c.origin === "server" ? "☁ z serwera" : c.origin === "app" ? "📱 własny" : "• pochodzenie ?"}
                      </Text>
                      {" · "}🕘 {fmtAgo(c.createdAt)}
                      {c.name ? ` · ${fmtWhen(c.createdAt)}` : ""}
                    </Text>
                  </View>
                  <Pressable onPress={() => promptRename(c)} hitSlop={8}>
                    <Text style={styles.rename}>✏️</Text>
                  </Pressable>
                </View>

                {/* Wysyłka na serwer + znacznik stanu (na serwerze / zaimportowany do labu). */}
                {(() => {
                  const hash = c.sig || c.id;
                  const st = sampleStatus[hash];
                  const onSrv = !!(st?.onServer || st?.imported);
                  // „Aktualizuj" tylko gdy treść sampla różni się od ostatnio wysłanej (nowy skan/nazwa…).
                  const changed = uploadedSigs[hash] !== contentSig(c);
                  return (
                    <View style={styles.sampleRow}>
                      {st?.imported ? (
                        <Text style={[styles.sampleBadge, styles.sampleImported]}>✓ zaimportowany do labu{!changed ? " · aktualny" : ""}</Text>
                      ) : st?.onServer ? (
                        <Text style={[styles.sampleBadge, styles.sampleOnServer]}>☁ na serwerze{!changed ? " · aktualny" : ""}</Text>
                      ) : (
                        <Text style={styles.sampleDim}>nie wysłano</Text>
                      )}
                      {(!onSrv || changed) ? (
                        <Pressable
                          style={[styles.sampleBtn, uploading === c.id && styles.disabled]}
                          disabled={uploading === c.id}
                          onPress={() => void uploadOne(c)}
                        >
                          <Text style={styles.sampleBtnText}>
                            {uploading === c.id ? "wysyłam…" : (onSrv ? "☁ Aktualizuj na serwerze" : "☁ Wyślij na serwer")}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })()}

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

                {/* Zwięzłe meta wejścia. */}
                <Text style={styles.metaLine}>
                  📷 {c.images.length} ·{" "}
                  📍{" "}
                  {c.location
                    ? `${c.location.lat.toFixed(4)}, ${c.location.lng.toFixed(4)} (${sourceLabel(c)})`
                    : sourceLabel(c)}
                </Text>
                {c.restaurantHint ? <Text style={styles.metaLine}>🏷️ {c.restaurantHint}</Text> : null}
                {c.locationHint ? <Text style={styles.metaLine}>🌍 {c.locationHint}</Text> : null}
                <Text style={styles.metaLine}>
                  ⚙️ EXIF {c.useExifLocation ? "✓" : "✗"} · GPS telefonu {c.useDeviceLocation ? "✓" : "✗"}
                </Text>

                {/* Hub uruchomień — przebiegi tego wejścia (najnowszy na górze), każdy do historii. */}
                <View style={styles.runs}>
                  <Text style={styles.runsTitle}>Uruchomienia ({runs.length})</Text>
                  {runs.length === 0 ? (
                    <Text style={styles.dim}>Jeszcze nie uruchomiono — „Wczytaj do skanu" i przetłumacz.</Text>
                  ) : (
                    runs
                      .slice()
                      .reverse()
                      .map((r, i) => {
                        const scan = scanById.get(r.scanId);
                        if (!scan) {
                          return (
                            <Text key={i} style={styles.runGone}>
                              • {fmtAgo(r.at)} · wynik usunięty z historii
                            </Text>
                          );
                        }
                        return (
                          <Pressable key={i} style={styles.runRow} onPress={() => onOpenScan(scan)}>
                            <Text style={styles.runMain} numberOfLines={1}>
                              🧪 {modelSummary(scan)} · {itemCount(scan)} dań
                              {costOf(scan) ? ` · ${costOf(scan)}` : ""} · {fmtAgo(r.at)}
                            </Text>
                            <Text style={styles.runChevron}>›</Text>
                          </Pressable>
                        );
                      })
                  )}
                </View>

                <View style={styles.actions}>
                  <Pressable style={styles.replay} onPress={() => onReplay(c)}>
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
            );
          })
        )}
      </ScrollView>
      <Lightbox state={preview} onClose={() => setPreview(null)} />
    </>
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
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  exportText: { color: colors.accent, fontWeight: "800", fontSize: 14 },
  importBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: "center", marginBottom: 14 },
  importBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  toolbar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  toolbarInfo: { fontSize: 12, color: colors.muted },
  deleteAll: { fontSize: 12, color: colors.error, fontWeight: "700" },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.badgeBg,
  },
  titleRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  titleMain: { flex: 1 },
  title: { fontSize: 15, fontWeight: "800", color: colors.text },
  titleSub: { fontSize: 11, color: colors.muted, marginTop: 1 },
  originServer: { fontSize: 11, color: "#5aa9e6", fontWeight: "700" }, // ☁ z serwera
  originApp: { fontSize: 11, color: "#7fd6a0", fontWeight: "700" }, // 📱 własny
  rename: { fontSize: 16, paddingLeft: 10 },
  sampleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" },
  sampleBadge: { fontSize: 11, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden" },
  sampleOnServer: { backgroundColor: "#DDEBFF", color: "#1A4E8A" },
  sampleImported: { backgroundColor: "#D7EFD7", color: "#2E7D32" },
  sampleDim: { fontSize: 11, color: colors.muted },
  sampleBtn: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  sampleBtnText: { color: colors.buttonText, fontWeight: "800", fontSize: 12 },
  thumbRow: { flexDirection: "row", marginTop: 10 },
  thumb: { width: 64, height: 80, borderRadius: 8, marginRight: 8, backgroundColor: colors.badgeBg },
  metaLine: { fontSize: 12, color: colors.text, marginTop: 4 },
  runs: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.badgeBg, paddingTop: 8 },
  runsTitle: { fontSize: 12, fontWeight: "800", color: colors.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 },
  dim: { color: colors.muted, fontSize: 12 },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.bg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 4,
  },
  runMain: { flex: 1, fontSize: 13, color: colors.text, fontWeight: "600" },
  runChevron: { fontSize: 18, color: colors.muted, paddingLeft: 8 },
  runGone: { fontSize: 12, color: colors.muted, fontStyle: "italic", marginTop: 4 },
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
