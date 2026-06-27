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
  ocrAllCaptures,
  analyzeAllCaptures,
  type ScanCapture,
} from "./captures";
import { uploadSample, fetchSampleStatus, reportError, fetchAppServerSamples, downloadServerSampleZip, deleteServerSample } from "./api";
import type { SavedScan } from "./storage";
import { MODEL_OPTIONS, distinctModels } from "./types";
import { triageGroup } from "./triage";
import { Lightbox, type LightboxState } from "./Lightbox";
import { Icon } from "./Icon";
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
  // OCR wchodzi w podpis treści (bloki.linie.słowa) — po policzeniu LUB regeneracji OCR (wzbogacenie o słowa)
  // sampel pokaże się jako „do aktualizacji" na serwerze. `o2` = wersja formatu (słowa+język) → wymusza re-upload.
  const ocr = c.images.map((im) => {
    if (!im.ocr) return "0";
    let lines = 0, words = 0;
    for (const b of im.ocr.blocks) { lines += b.lines.length; for (const l of b.lines) words += (l.words?.length ?? 0); }
    return `${im.ocr.blocks.length}.${lines}.${words}`;
  }).join(",");
  // Analiza menu-AI też wchodzi w podpis (liczba modeli + znacznik czasu) → po policzeniu/regeneracji sampel
  // pokaże się jako „do aktualizacji" na serwerze (jak OCR). `at` w kluczu wymusza re-upload po regeneracji.
  const ai = c.images.map((im) => {
    if (!im.menuAi) return "0";
    const n = (im.menuAi.mlkit ? 1 : 0) + (im.menuAi.appleVision ? 1 : 0) + (im.menuAi.clip ? 1 : 0);
    return `${n}@${im.menuAi.at}${im.menuAiCrop ? `+c${im.menuAiCrop.at}` : ""}`;
  }).join(",");
  return `${c.scanId ?? ""}|${c.name ?? ""}|${c.restaurantHint ?? ""}|${c.locationHint ?? ""}|${c.runs?.length ?? 0}|o2:${ocr}|ai:${ai}`;
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
  const [ocrProg, setOcrProg] = useState<{ done: number; total: number } | null>(null); // postęp batcha OCR
  const [aiProg, setAiProg] = useState<{ done: number; total: number } | null>(null); // postęp batcha analizy menu-AI
  const [uploadProg, setUploadProg] = useState<{ done: number; total: number } | null>(null); // postęp wysyłki wielu sampli
  // Stan migawek na serwerze (po hashu/sygnaturze): na serwerze? zaimportowane do labu?
  const [sampleStatus, setSampleStatus] = useState<Record<string, { onServer: boolean; imported: boolean }>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [sentFlash, setSentFlash] = useState<Record<string, string>>({}); // krótki „✓ wysłano/zaktualizowano" w markerze (bez popupu)
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

  // Re-upload (aktualizacja) wielu sampli po kolei — pojedynczy błąd nie blokuje reszty. Z paskiem postępu.
  async function uploadMany(caps: ScanCapture[]) {
    setUploadProg({ done: 0, total: caps.length });
    let i = 0;
    for (const c of caps) { try { await uploadOne(c); } catch { /* idziemy dalej */ } setUploadProg({ done: ++i, total: caps.length }); }
    setUploadProg(null);
    await load();
  }

  // Czy sampel ma NOWE/ZMIENIONE dane do wysłania: nie ma go na serwerze ALBO treść (OCR/menu-AI/nazwa) różni się
  // od ostatnio wysłanej (`contentSig` ≠ zapamiętany). Napędza marker „● nowe dane" i bulk „wyślij wszystkie nowe".
  function needsSync(c: ScanCapture): boolean {
    const hash = c.sig || c.id;
    const st = sampleStatus[hash];
    const onSrv = !!(st?.onServer || st?.imported);
    return !onSrv || uploadedSigs[hash] !== contentSig(c);
  }

  // Policz OCR dla zdjęć migawek (on-device) i zapisz; potem zaproponuj wysłanie na serwer.
  //  • force=false → tylko zdjęcia bez OCR (szybkie uzupełnienie).
  //  • force=true  → REGENERACJA: przelicz wszystkie od nowa (np. po wzbogaceniu formatu o słowa/język).
  async function runOcrAll(force = false) {
    if (ocrProg) return;
    setOcrProg({ done: 0, total: 0 });
    try {
      const r = await ocrAllCaptures((done, total) => setOcrProg({ done, total }), force);
      await load();
      // Zaproponuj wysyłkę WSZYSTKICH sampli (nie tylko tych już na serwerze) — niezmienione wrócą jako „bez zmian",
      // ale nic nie zostaje po cichu pominięte. Po regeneracji treść OCR się zmienia → serwer przyjmie jako update.
      const fresh = await listCaptures();
      if (fresh.length) {
        Alert.alert(force ? "OCR zregenerowany" : "OCR policzony", `${r.done}/${r.total} zdjęć przeliczono. Wysłać wszystkie ${fresh.length} sampli na serwer (z OCR)?`, [
          { text: "Później", style: "cancel" },
          { text: "Wyślij na serwer", onPress: () => void uploadMany(fresh) },
        ]);
      }
    } catch (e) {
      reportError((e as Error)?.message ?? String(e), { label: force ? "ocr-regen" : "ocr-all" });
    } finally {
      setOcrProg(null);
    }
  }

  // Analiza zdjęć menu lokalnymi modelami (mlkit/apple-vision/clip) — surowe wyniki do sampla; potem wysyłka na serwer.
  // Zawsze REGENERUJE (force) — eksperymentujemy z promptami, więc chcemy świeże wyniki przy każdym uruchomieniu.
  async function runAnalyzeAll() {
    if (aiProg) return;
    setAiProg({ done: 0, total: 0 });
    try {
      const r = await analyzeAllCaptures((done, total) => setAiProg({ done, total }), true);
      await load();
      const fresh = await listCaptures();
      if (fresh.length) {
        Alert.alert("Analiza AI policzona", `${r.done}/${r.total} zdjęć przeanalizowano (mlkit/apple/clip). Wysłać wszystkie ${fresh.length} sampli na serwer (z analizą)?`, [
          { text: "Później", style: "cancel" },
          { text: "Wyślij na serwer", onPress: () => void uploadMany(fresh) },
        ]);
      }
    } catch (e) {
      reportError((e as Error)?.message ?? String(e), { label: "menuai-all" });
    } finally {
      setAiProg(null);
    }
  }

  async function load() {
    const caps = await listCaptures().catch(() => []);
    // Lista od NAJNOWSZEJ po dacie ZROBIENIA migawki (createdAt) — nie po kolejności zapisu/importu.
    caps.sort((a, b) => b.createdAt - a.createdAt);
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
      // Bez popupu — krótki feedback w markerze na kafelku.
      const flash = r.status === "updated" ? "✓ zaktualizowano" : r.status === "exists" ? "✓ bez zmian" : "✓ wysłano";
      const key = c.sig || c.id;
      setSentFlash((prev) => ({ ...prev, [key]: flash }));
      setTimeout(() => setSentFlash((prev) => { const n = { ...prev }; delete n[key]; return n; }), 2500);
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
          <Text style={styles.importBtnText}>
            <Icon name={importing ? "hourglass" : "download"} size={14} color="#fff" />{" "}
            {importing ? "Importuję z serwera…" : "Importuj sample z serwera"}
          </Text>
        </Pressable>

        {captures.length > 0 ? (
          <>
            <Pressable
              style={[styles.export, !!exporting && styles.disabled]}
              disabled={!!exporting}
              onPress={() => doExport("all")}
            >
              <Text style={styles.exportText}>
                <Icon name={exporting === "all" ? "hourglass" : "upload"} size={14} color={colors.accent} />{" "}
                {exporting === "all" ? "Pakuję ZIP…" : `Wyeksportuj wszystkie (${captures.length}) do ZIP`}
              </Text>
            </Pressable>
            <Pressable style={[styles.export, !!ocrProg && styles.disabled]} disabled={!!ocrProg} onPress={() => void runOcrAll(true)}>
              <Text style={styles.exportText}>
                <Icon name={ocrProg ? "hourglass" : "searchAlt"} size={14} color={colors.accent} />{" "}
                {ocrProg ? `Generuję OCR… ${ocrProg.done}/${ocrProg.total}` : "Generuj OCR dla wszystkich (on-device)"}
              </Text>
            </Pressable>
            <Pressable style={[styles.export, !!aiProg && styles.disabled]} disabled={!!aiProg} onPress={() => void runAnalyzeAll()}>
              <Text style={styles.exportText}>
                <Icon name={aiProg ? "hourglass" : "flask"} size={14} color={colors.accent} />{" "}
                {aiProg ? `Analizuję zdjęcia… ${aiProg.done}/${aiProg.total}` : "Analizuj zdjęcia (AI) dla wszystkich (mlkit/apple/clip)"}
              </Text>
            </Pressable>
            {/* BULK: wyślij na serwer wszystkie sample z NOWYMI/ZMIENIONYMI danymi (nie wysłane lub zmieniony OCR/menu-AI). */}
            {!uploadProg ? (() => {
              const pending = captures.filter(needsSync);
              return pending.length > 0 ? (
                <Pressable style={styles.syncAllBtn} onPress={() => void uploadMany(pending)}>
                  <Text style={styles.syncAllText}>
                    <Icon name="cloud" size={14} color="#fff" /> Wyślij wszystkie nowe/zaktualizowane ({pending.length})
                  </Text>
                </Pressable>
              ) : null;
            })() : null}
            {uploadProg ? (
              <View style={[styles.export, styles.disabled]}>
                <Text style={styles.exportText}>
                  <Icon name="cloud" size={14} color={colors.accent} /> Wysyłam na serwer… {uploadProg.done}/{uploadProg.total}
                </Text>
              </View>
            ) : null}
            <View style={styles.toolbar}>
              <Text style={styles.toolbarInfo}>
                {captures.length} migawek · {fmtBytes(capturesDiskBytes(captures))} na dysku
              </Text>
              <Pressable onPress={confirmDeleteAll} hitSlop={6}>
                <Text style={styles.deleteAll}>
                  <Icon name="delete" size={13} color={colors.error} /> Usuń wszystkie
                </Text>
              </Pressable>
            </View>
          </>
        ) : null}

        {captures.length === 0 ? (
          <Text style={styles.empty}>Brak migawek — zrób skan, a pojawi się tutaj.</Text>
        ) : (
          captures.map((c) => {
            const allRuns = captureRuns(c); // WSZYSTKIE przebiegi — tylko do LICZNIKA (skasowane z historii też się liczą)
            const runs = allRuns.filter((r) => scanById.has(r.scanId)); // tylko ŻYWE (wynik wciąż w historii) — do LISTY
            return (
              <View key={c.id} style={styles.card}>
                <View style={styles.titleRow}>
                  <View style={styles.titleMain}>
                    <Text style={styles.title} numberOfLines={1}>
                      {c.name || fmtWhen(c.createdAt)}
                    </Text>
                    <Text style={styles.titleSub}>
                      <Text style={c.origin === "server" ? styles.originServer : c.origin === "app" ? styles.originApp : styles.titleSub}>
                        {c.origin === "server" ? (
                          <><Icon name="cloud" size={11} color="#5aa9e6" /> z serwera</>
                        ) : c.origin === "app" ? (
                          <><Icon name="device" size={11} color="#7fd6a0" /> własny</>
                        ) : (
                          <><Icon name="dot" size={8} color={colors.muted} /> pochodzenie ?</>
                        )}
                      </Text>
                      {" · "}<Icon name="clock" size={11} color={colors.muted} /> {fmtAgo(c.createdAt)}
                      {c.name ? ` · ${fmtWhen(c.createdAt)}` : ""}
                    </Text>
                  </View>
                  <Pressable onPress={() => promptRename(c)} hitSlop={8}>
                    <Icon name="edit" size={17} color={colors.muted} style={styles.rename} />
                  </Pressable>
                </View>

                {/* GŁÓWNA AKCJA na górze — najczęściej używana: wczytaj WEJŚCIE na ekran skanu. */}
                <Pressable style={styles.replayTop} onPress={() => onReplay(c)}>
                  <Text style={styles.replayText}>
                    <Icon name="download" size={14} color={colors.buttonText} /> Wczytaj do skanu
                  </Text>
                </Pressable>

                {c.images.length > 0 ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbRow}>
                    {c.images.map((im, i) => (
                      <Pressable
                        key={i}
                        onPress={() =>
                          setPreview({
                            photos: c.images.map((p) => ({ url: resolveCaptureUri(p.path) ?? p.path, source: "menu" })),
                            index: i,
                            allowMenuDetect: true, // migawka = zdjęcie menu → pokaż przycisk OCR „Zaznacz menu"
                          })
                        }
                      >
                        <View>
                          <Image source={{ uri: resolveCaptureUri(im.path) }} style={styles.thumb} />
                          {im.ocr ? (
                            <View style={styles.ocrBadge}><Text style={styles.ocrBadgeText}>OCR {im.ocr.blocks.length}</Text></View>
                          ) : null}
                          {im.menuAi ? (
                            <View style={styles.aiBadge}><Text style={styles.aiBadgeText}>🧠 {(im.menuAi.mlkit ? 1 : 0) + (im.menuAi.appleVision ? 1 : 0) + (im.menuAi.clip ? 1 : 0)}</Text></View>
                          ) : null}
                          {(im.ocr || im.menuAi) ? (() => { const t = triageGroup(im.ocr, im.menuAi); return (
                            <View style={styles.triageBadge}><Text style={styles.triageBadgeText} numberOfLines={1}>{t.emoji} {t.label}</Text></View>
                          ); })() : null}
                        </View>
                      </Pressable>
                    ))}
                  </ScrollView>
                ) : null}

                {/* Zwięzłe meta wejścia. */}
                <Text style={styles.metaLine}>
                  <Icon name="camera" size={12} color={colors.muted} /> {c.images.length} ·{" "}
                  <Icon name="location" size={12} color={colors.muted} />{" "}
                  {c.location
                    ? `${c.location.lat.toFixed(4)}, ${c.location.lng.toFixed(4)} (${sourceLabel(c)})`
                    : sourceLabel(c)}
                </Text>
                {c.restaurantHint ? (
                  <Text style={styles.metaLine}><Icon name="tag" size={12} color={colors.muted} /> {c.restaurantHint}</Text>
                ) : null}
                {c.locationHint ? (
                  <Text style={styles.metaLine}><Icon name="globe" size={12} color={colors.muted} /> {c.locationHint}</Text>
                ) : null}
                <Text style={styles.metaLine}>
                  <Icon name="settings" size={12} color={colors.muted} /> EXIF{" "}
                  <Icon name={c.useExifLocation ? "check" : "close"} size={12} color={c.useExifLocation ? "#2E7D32" : colors.error} />
                  {" · "}GPS telefonu{" "}
                  <Icon name={c.useDeviceLocation ? "check" : "close"} size={12} color={c.useDeviceLocation ? "#2E7D32" : colors.error} />
                </Text>

                {/* Hub uruchomień — przebiegi tego wejścia (najnowszy na górze), każdy do historii. */}
                <View style={styles.runs}>
                  <Text style={styles.runsTitle}>Uruchomienia ({allRuns.length})</Text>
                  {allRuns.length === 0 ? (
                    <Text style={styles.dim}>Jeszcze nie uruchomiono — „Wczytaj do skanu" i przetłumacz.</Text>
                  ) : (
                    runs
                      .slice()
                      .reverse()
                      .map((r, i) => {
                        const scan = scanById.get(r.scanId)!; // runs przefiltrowane do żywych → scan zawsze istnieje
                        return (
                          <Pressable key={i} style={styles.runRow} onPress={() => onOpenScan(scan)}>
                            <Text style={styles.runMain} numberOfLines={1}>
                              <Icon name="flask" size={13} color={colors.accent} /> {modelSummary(scan)} · {itemCount(scan)} dań
                              {costOf(scan) ? ` · ${costOf(scan)}` : ""} · {fmtAgo(r.at)}
                            </Text>
                            <Text style={styles.runChevron}>›</Text>
                          </Pressable>
                        );
                      })
                  )}
                </View>

                {/* STREFA POBOCZNA (dół): stan + eksport/kasowanie w jednym rzędzie; synchronizacja jako cichy guzik-obrys. */}
                {(() => {
                  const hash = c.sig || c.id;
                  const st = sampleStatus[hash];
                  const onSrv = !!(st?.onServer || st?.imported);
                  // „Aktualizuj" tylko gdy treść sampla różni się od ostatnio wysłanej (nowy skan/nazwa…).
                  const changed = uploadedSigs[hash] !== contentSig(c);
                  const flash = sentFlash[hash];
                  return (
                    <View style={styles.secondary}>
                      <View style={styles.footerRow}>
                        {flash ? (
                          <Text style={[styles.sampleBadge, styles.sampleImported]} numberOfLines={1}>{flash}</Text>
                        ) : onSrv && changed ? ( // na serwerze, ale apka policzyła NOWE dane (OCR/menu-AI) → do dosłania
                          <Text style={[styles.sampleBadge, styles.sampleNew]} numberOfLines={1}>
                            <Icon name="cloud" size={11} color={colors.accent} /> ● nowe dane do wysłania
                          </Text>
                        ) : st?.imported ? (
                          <Text style={[styles.sampleBadge, styles.sampleImported]} numberOfLines={1}>
                            <Icon name="check" size={11} color="#2E7D32" /> zaimportowany · aktualny
                          </Text>
                        ) : st?.onServer ? (
                          <Text style={[styles.sampleBadge, styles.sampleOnServer]} numberOfLines={1}>
                            <Icon name="cloud" size={11} color="#1A4E8A" /> na serwerze · aktualny
                          </Text>
                        ) : (
                          <Text style={[styles.sampleBadge, styles.sampleNew]} numberOfLines={1}>● nowe — nie wysłano</Text>
                        )}
                        <View style={styles.footerIcons}>
                          <Pressable hitSlop={10} disabled={!!exporting} onPress={() => doExport(c.id, [c.id])}>
                            <Icon name={exporting === c.id ? "hourglass" : "upload"} size={20} color={exporting ? colors.muted : colors.accent} />
                          </Pressable>
                          <Pressable hitSlop={10} onPress={() => confirmDelete(c)}>
                            <Icon name="delete" size={20} color={colors.error} />
                          </Pressable>
                        </View>
                      </View>
                      {(!onSrv || changed) ? (
                        <Pressable
                          style={[styles.syncGhost, uploading === c.id && styles.disabled]}
                          disabled={uploading === c.id}
                          onPress={() => void uploadOne(c)}
                        >
                          <Text style={styles.syncGhostText}>
                            {uploading === c.id ? (
                              "wysyłam…"
                            ) : (
                              <><Icon name="cloud" size={12} color={colors.accent} /> {onSrv ? "Aktualizuj na serwerze" : "Wyślij na serwer"}</>
                            )}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  );
                })()}
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
  syncAllBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: "center", marginBottom: 10 },
  syncAllText: { color: "#fff", fontWeight: "800", fontSize: 14 },
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
  sampleBadge: { fontSize: 11, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, overflow: "hidden", flexShrink: 1 },
  sampleOnServer: { backgroundColor: "#DDEBFF", color: "#1A4E8A" },
  sampleImported: { backgroundColor: "#D7EFD7", color: "#2E7D32" },
  sampleNew: { backgroundColor: colors.badgeBg, color: colors.accent },
  sampleDim: { fontSize: 11, color: colors.muted },
  thumbRow: { flexDirection: "row", marginTop: 10 },
  thumb: { width: 64, height: 80, borderRadius: 8, marginRight: 8, backgroundColor: colors.badgeBg },
  ocrBadge: { position: "absolute", top: 3, left: 3, backgroundColor: "rgba(74,222,128,0.9)", borderRadius: 5, paddingHorizontal: 4, paddingVertical: 1 },
  ocrBadgeText: { color: "#06281a", fontSize: 9, fontWeight: "800" },
  aiBadge: { position: "absolute", top: 3, right: 11, backgroundColor: "rgba(167,139,250,0.92)", borderRadius: 5, paddingHorizontal: 4, paddingVertical: 1 },
  aiBadgeText: { color: "#1a1033", fontSize: 9, fontWeight: "800" },
  triageBadge: { position: "absolute", bottom: 0, left: 0, right: 8, backgroundColor: "rgba(0,0,0,0.72)", borderBottomLeftRadius: 8, borderBottomRightRadius: 8, paddingHorizontal: 3, paddingVertical: 2 },
  triageBadgeText: { color: "#fff", fontSize: 9, fontWeight: "800", textAlign: "center" },
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
  replayTop: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 13, alignItems: "center", marginTop: 12 },
  replayText: { color: colors.buttonText, fontWeight: "800", fontSize: 14 },
  secondary: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.badgeBg, gap: 8 },
  footerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  footerIcons: { flexDirection: "row", alignItems: "center", gap: 18 },
  syncGhost: { borderWidth: 1, borderColor: colors.accent, borderRadius: 9, paddingVertical: 9, alignItems: "center", backgroundColor: "transparent" },
  syncGhostText: { color: colors.accent, fontWeight: "700", fontSize: 13 },
  disabled: { opacity: 0.4 },
});
