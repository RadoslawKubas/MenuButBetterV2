// Własny aparat: migawka robi zdjęcie i pokazuje je ZAMROŻONE (podgląd „Użyj / Ponów").
//  • „✓ Użyj"  → dodaje zdjęcie i WRACA do aparatu (nie zamyka) — można robić serię.
//  • „↺ Ponów" → odrzuca i wraca do aparatu.
//  • „Gotowe (N)" → zamyka; wszystkie użyte zdjęcia są już dodane do skanu.
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Icon } from "./Icon";
import { CameraView, useCameraPermissions } from "expo-camera";
import { MAX_IMAGES, setModelCropInsets } from "./image";
import { detectMenuRegion, type MenuRegion } from "./menuRegion";
import { MenuRegionOverlay } from "./MenuRegionOverlay";
import type { PeekResult } from "./api";
import { colors } from "./theme";

type Pending = { uri: string; exif: Record<string, unknown> | null };
export type Shot = { uri: string; peek?: PeekResult; peeking?: boolean };

// Tekst oceny „szybkiego podglądu" (banner + galeria).
function peekText(info: PeekResult | null | undefined): string {
  if (info === undefined) return "— brak oceny (podgląd wył. lub w toku) —";
  if (!info) return "podgląd gotowy — pstryknij zdjęcie";
  if (!info.isMenu) return "to nie wygląda na menu";
  const parts = [info.cuisine ? `${info.cuisine}` : "", info.restaurantName ? `${info.restaurantName}` : ""].filter(Boolean);
  return parts.length ? parts.join("  ·  ") : "✓ wygląda na menu";
}

export function CameraCapture({
  visible,
  count,
  onCapture,
  onFreeze,
  onClose,
  peekEnabled,
  onTogglePeek,
  peekInfo,
  peeking,
  shots,
  onRemoveShot,
}: {
  visible: boolean;
  count: number;
  onCapture: (uri: string, exif?: Record<string, unknown> | null) => Promise<void>;
  onFreeze?: (uri: string, exif?: Record<string, unknown> | null) => void;
  onClose: () => void;
  peekEnabled: boolean;
  onTogglePeek: (on: boolean) => void;
  peekInfo: PeekResult | null;
  peeking: boolean;
  shots: Shot[];
  onRemoveShot: (uri: string) => void;
}) {
  const { width, height } = useWindowDimensions();
  // Crop „do modelu" = obszar między scrimami paska górnego/dolnego: mierzymy ich realne wysokości (px) i podajemy
  // jako ułamki wysokości ekranu → kadr trafiający do OCR = dokładnie to, co widać między ciemnymi paskami.
  const [topH, setTopH] = useState(0);
  const [barH, setBarH] = useState(0);
  useEffect(() => {
    if (topH > 0 && barH > 0 && height > 0) setModelCropInsets(topH / height, barH / height);
  }, [topH, barH, height]);
  const ref = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false); // robienie zdjęcia
  const [saving, setSaving] = useState(false); // przetwarzanie „Użyj"
  const [pending, setPending] = useState<Pending | null>(null); // zamrożony podgląd
  const [camRegion, setCamRegion] = useState<MenuRegion | null>(null); // on-device OCR: prostokąt/siatka menu dla zamrożonego zdjęcia
  // AUTO on-device OCR na ZAMROŻONYM zdjęciu (jak w Migawkach) — od razu po pstryknięciu pokaż prostokąt/siatkę menu.
  useEffect(() => {
    if (!pending?.uri) { setCamRegion(null); return; }
    let cancelled = false;
    setCamRegion(null);
    detectMenuRegion(pending.uri).then((r) => { if (!cancelled) setCamRegion(r); }).catch(() => { if (!cancelled) setCamRegion(null); });
    return () => { cancelled = true; };
  }, [pending]);
  const [torch, setTorch] = useState(false); // latarka (doświetlenie menu)
  const [zoom, setZoom] = useState(0); // 0..1 (expo-camera) — pinch + chipy powiększeń
  // Rozdzielczość PRZECHWYTYWANIA: domyślnie expo-camera bierze NIŻSZĄ niż natywny aparat → zdjęcia menu wychodzą
  // miększe/słabsze. Po `onCameraReady` ustawiamy NAJWYŻSZĄ dostępną (iOS: preset „photo"; Android: max „WxH").
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);
  async function pickMaxPictureSize() {
    try {
      const sizes = await ref.current?.getAvailablePictureSizesAsync();
      if (!sizes?.length) return;
      let best: string | undefined;
      if (sizes.includes("photo")) best = "photo"; // iOS: najwyższa rozdzielczość stilla
      else { let area = 0; for (const s of sizes) { const m = /^(\d+)x(\d+)$/.exec(s); if (m) { const a = Number(m[1]) * Number(m[2]); if (a > area) { area = a; best = s; } } } }
      if (best) setPictureSize(best);
    } catch { /* zostaw domyślną */ }
  }
  const zoomRef = useRef(0);
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);
  const applyZoom = (z: number) => { const v = Math.max(0, Math.min(1, z)); zoomRef.current = v; setZoom(v); };
  // Pinch (2 palce) nad podglądem aparatu → płynny zoom. Pojedyncze dotyki puszczamy (migawka itd.).
  const pinch = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (e) => e.nativeEvent.touches.length === 2,
      onMoveShouldSetPanResponder: (e) => e.nativeEvent.touches.length === 2,
      onPanResponderGrant: (e) => {
        const t = e.nativeEvent.touches;
        if (t.length === 2) pinchStart.current = { dist: Math.hypot(t[0]!.pageX - t[1]!.pageX, t[0]!.pageY - t[1]!.pageY), zoom: zoomRef.current };
      },
      onPanResponderMove: (e) => {
        const t = e.nativeEvent.touches;
        if (t.length === 2 && pinchStart.current) {
          const d = Math.hypot(t[0]!.pageX - t[1]!.pageX, t[0]!.pageY - t[1]!.pageY);
          applyZoom(pinchStart.current.zoom + (d / pinchStart.current.dist - 1) * 0.35); // czułość
        }
      },
      onPanResponderRelease: () => { pinchStart.current = null; },
      onPanResponderTerminate: () => { pinchStart.current = null; },
    }),
  ).current;
  // Chipy „natywne" — przybliżenia 0..1 (cyfrowy zoom expo-camera jest nieliniowy, niskie wartości = przydatny zakres).
  const ZOOM_PRESETS: { label: string; z: number }[] = [
    { label: "1×", z: 0 }, { label: "2×", z: 0.04 }, { label: "3×", z: 0.09 }, { label: "5×", z: 0.2 },
  ];
  const [gallery, setGallery] = useState(false); // galeria zdjęć tej sesji
  const pagerRef = useRef<FlatList<Shot>>(null);
  const [galIdx, setGalIdx] = useState(0); // bieżąca strona galerii (do paska miniatur)
  const galTranslateY = useRef(new Animated.Value(0)).current;
  const galBg = useRef(new Animated.Value(1)).current;

  function resetGalPan() {
    Animated.spring(galTranslateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
    Animated.spring(galBg, { toValue: 1, useNativeDriver: true, bounciness: 0 }).start();
  }
  function openGallery(at: number) {
    galTranslateY.setValue(0);
    galBg.setValue(1);
    setGalIdx(at);
    setGallery(true);
  }
  function deleteCurrent() {
    const s = shots[galIdx];
    if (!s) return;
    if (shots.length <= 1) setGallery(false); // ostatnie zdjęcie → zamknij galerię
    onRemoveShot(s.uri);
  }
  // Gdy lista się skróci (usunięcie), nie wychodź poza zakres.
  useEffect(() => {
    if (gallery && galIdx > shots.length - 1) setGalIdx(Math.max(0, shots.length - 1));
  }, [shots.length, gallery, galIdx]);

  // Gest pionowy w górę → zamknij galerię (poziome zostają dla pagera). Jak w Lightboxie.
  const galPan = useRef(
    PanResponder.create({
      // CAPTURE: rodzic łapie WYRAŹNY ruch w górę zanim przejmie go poziomy FlatList;
      // poziome (przeglądanie) i drobne ruchy puszczamy dalej do pagera.
      onMoveShouldSetPanResponderCapture: (_, g) => g.dy < -12 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => {
        const dy = Math.min(0, g.dy);
        galTranslateY.setValue(dy);
        galBg.setValue(Math.max(0.15, 1 + dy / 400));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy < -110 || g.vy < -0.6) {
          Animated.parallel([
            Animated.timing(galTranslateY, { toValue: -1200, duration: 180, useNativeDriver: true }),
            Animated.timing(galBg, { toValue: 0, duration: 180, useNativeDriver: true }),
          ]).start(() => {
            setGallery(false);
            galTranslateY.setValue(0);
            galBg.setValue(1);
          });
        } else {
          resetGalPan();
        }
      },
      onPanResponderTerminate: () => resetGalPan(),
    }),
  ).current;

  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  // Reset podglądu przy zamknięciu, żeby następne otwarcie startowało od żywego aparatu.
  useEffect(() => {
    if (!visible) {
      setPending(null);
      setBusy(false);
      setSaving(false);
      setGallery(false);
      setTorch(false);
      applyZoom(0);
    }
  }, [visible]);

  if (!visible) return null;

  const full = count >= MAX_IMAGES;

  async function shoot() {
    if (busy || full || pending) return;
    setBusy(true);
    try {
      const photo = await ref.current?.takePictureAsync({ quality: 1, exif: true });
      if (photo?.uri) {
        const exif = (photo.exif ?? null) as Record<string, unknown> | null;
        setPending({ uri: photo.uri, exif });
        onFreeze?.(photo.uri, exif); // peek OD RAZU na zamrożonym kadrze (nie czekamy na „✓ Użyj")
      }
    } catch {
      // nieudane zdjęcie — można pstryknąć ponownie
    } finally {
      setBusy(false);
    }
  }

  async function usePending() {
    if (!pending || saving) return;
    setSaving(true);
    try {
      await onCapture(pending.uri, pending.exif);
    } catch {
      // przetwarzanie nie powiodło się — wracamy do aparatu, można powtórzyć
    } finally {
      setSaving(false);
      setPending(null); // wróć do żywego aparatu
    }
  }

  function retake() {
    if (saving) return;
    setPending(null);
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {permission?.granted ? (
          <>
            {/* Żywy aparat pod spodem — zostaje „ciepły". */}
            <CameraView ref={ref} style={styles.camera} facing="back" enableTorch={torch} zoom={zoom} pictureSize={pictureSize} onCameraReady={pickMaxPictureSize} />

            {/* Warstwa pinch-zoom nad aparatem (paski są renderowane później → są na wierzchu). */}
            {!pending ? <View style={StyleSheet.absoluteFill} {...pinch.panHandlers} /> : null}

            {/* Zamrożony podgląd ostatniego zdjęcia. */}
            {pending ? (
              <Image source={{ uri: pending.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
            ) : null}
            {/* On-device OCR: prostokąt + perspektywiczna siatka menu na zamrożonym zdjęciu (auto, jak w Migawkach). */}
            {pending && camRegion ? <MenuRegionOverlay region={camRegion} boxW={width} boxH={height} /> : null}

            {/* Górny pasek: latarka + przełącznik „szybkiego podglądu" + banner z kontekstem. */}
            <View style={styles.topBar} onLayout={(e) => setTopH(e.nativeEvent.layout.height)}>
              <Pressable
                style={[styles.peekToggle, torch && styles.peekToggleOn]}
                onPress={() => setTorch((t) => !t)}
              >
                <Text style={styles.peekToggleText}>{torch ? "Latarka wł." : "Latarka"}</Text>
              </Pressable>
              <Pressable
                style={[styles.peekToggle, peekEnabled && styles.peekToggleOn]}
                onPress={() => onTogglePeek(!peekEnabled)}
              >
                <Text style={styles.peekToggleText}><Icon name="searchAlt" /> {peekEnabled ? "Podgląd wł." : "Podgląd wył."}</Text>
              </Pressable>
              {peekEnabled ? (
                <View style={styles.peekBanner}>
                  {peeking ? <ActivityIndicator color="#fff" size="small" /> : null}
                  <Text style={styles.peekBannerText} numberOfLines={1}>
                    {peeking ? "  analizuję…" : peekText(peekInfo)}
                  </Text>
                </View>
              ) : null}
            </View>

            {pending ? (
              // Pasek decyzji: Ponów / Użyj (Użyj wraca do aparatu).
              <View style={styles.bar}>
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={retake} disabled={saving}>
                  <Text style={styles.btnGhostText}>↺ Ponów</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnUse, saving && styles.btnOff]} onPress={usePending} disabled={saving}>
                  {saving ? <ActivityIndicator color={colors.buttonText} /> : <Text style={styles.btnUseText}>✓ Użyj</Text>}
                </Pressable>
              </View>
            ) : (
              <>
              {/* Chipy zoomu (natywny styl) — nad paskiem; aktywny = najbliższy preset. */}
              <View style={styles.zoomBar} pointerEvents="box-none">
                {ZOOM_PRESETS.map((p) => {
                  const active = Math.abs(zoom - p.z) < 0.02;
                  return (
                    <Pressable key={p.label} style={[styles.zoomChip, active && styles.zoomChipOn]} onPress={() => applyZoom(p.z)}>
                      <Text style={[styles.zoomChipText, active && styles.zoomChipTextOn]}>{p.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {/* Pasek aparatu: Gotowe / migawka / licznik. */}
              <View style={styles.bar} onLayout={(e) => setBarH(e.nativeEvent.layout.height)}>
                <Pressable style={styles.side} onPress={onClose}>
                  <Text style={styles.doneText}>Gotowe ({count})</Text>
                </Pressable>
                <Pressable
                  style={[styles.shutter, (busy || full) && styles.shutterOff]}
                  onPress={shoot}
                  disabled={busy || full}
                >
                  {busy ? <ActivityIndicator color="#000" /> : <View style={styles.shutterInner} />}
                </Pressable>
                <Pressable
                  style={[styles.side, styles.thumbSide]}
                  onPress={() => shots.length > 0 && openGallery(shots.length - 1)}
                  disabled={shots.length === 0}
                >
                  {shots.length > 0 ? (
                    <View style={styles.thumbOuter}>
                      <View style={styles.thumbWrap}>
                        <Image source={{ uri: shots[shots.length - 1]!.uri }} style={styles.thumb} />
                      </View>
                      <View style={styles.thumbBadge}>
                        <Text style={styles.thumbBadgeText}>{full ? "Max" : count}</Text>
                      </View>
                    </View>
                  ) : (
                    <Text style={styles.counter}><Icon name="camera" /> 0</Text>
                  )}
                </Pressable>
              </View>
              </>
            )}
          </>
        ) : (
          <View style={styles.permWrap}>
            <Text style={styles.permText}>
              {permission && !permission.canAskAgain
                ? "Brak zgody na aparat. Włącz ją w Ustawieniach systemu."
                : "Potrzebuję dostępu do aparatu."}
            </Text>
            {permission?.canAskAgain ? (
              <Pressable style={styles.permBtn} onPress={() => void requestPermission()}>
                <Text style={styles.permBtnText}>Zezwól</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.permClose} onPress={onClose}>
              <Text style={styles.permCloseText}>Zamknij</Text>
            </Pressable>
          </View>
        )}

        {/* Galeria sesji: przeglądanie zrobionych zdjęć + ocena „szybkiego podglądu" per zdjęcie. */}
        {gallery && shots.length > 0 ? (
          <Animated.View
            {...galPan.panHandlers}
            style={[styles.galleryRoot, { opacity: galBg, transform: [{ translateY: galTranslateY }] }]}
          >
            <FlatList
              ref={pagerRef}
              data={shots}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              style={{ flex: 1 }}
              initialScrollIndex={Math.min(galIdx, shots.length - 1)}
              getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
              keyExtractor={(_, i) => String(i)}
              onMomentumScrollEnd={(e) => setGalIdx(Math.round(e.nativeEvent.contentOffset.x / width))}
              renderItem={({ item, index }) => (
                <View style={[styles.galleryPage, { width }]}>
                  <Image source={{ uri: item.uri }} style={{ width: width * 0.9, height: height * 0.5 }} resizeMode="contain" />
                  <View style={styles.galleryCaption}>
                    <Text style={styles.galleryIndex}>
                      Zdjęcie {index + 1} / {shots.length}
                    </Text>
                    <Text style={styles.galleryPeek}>{item.peeking ? "analizuję…" : peekText(item.peek)}</Text>
                  </View>
                </View>
              )}
            />

            <Pressable style={styles.galleryClose} onPress={() => setGallery(false)} hitSlop={12}>
              <Text style={styles.galleryCloseText}>✕</Text>
            </Pressable>
            <Text style={styles.galleryTopHint} pointerEvents="none">
              ↑ przesuń w górę, aby zamknąć
            </Text>
            <Pressable style={styles.galleryDelete} onPress={deleteCurrent} hitSlop={12}>
              <Text style={styles.galleryDeleteText}><Icon name="delete" /> Usuń to zdjęcie</Text>
            </Pressable>

            {/* Pasek miniatur do szybkiego przewijania (scroll, gdy się nie mieści). */}
            <View style={styles.stripWrap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
                {shots.map((s, i) => (
                  <Pressable key={i} onPress={() => pagerRef.current?.scrollToOffset({ offset: i * width, animated: true })}>
                    <Image source={{ uri: s.uri }} style={[styles.stripThumb, i === galIdx && styles.stripThumbActive]} />
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </Animated.View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 56,
    paddingBottom: 12,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  peekToggle: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  peekToggleOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  peekToggleText: { color: "#fff", fontWeight: "800", fontSize: 12 },
  peekBanner: { flex: 1, flexDirection: "row", alignItems: "center" },
  peekBannerText: { color: "#fff", fontSize: 13, fontWeight: "600", flexShrink: 1 },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingBottom: 40,
    paddingTop: 18,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  zoomBar: { position: "absolute", left: 0, right: 0, bottom: 150, flexDirection: "row", justifyContent: "center", gap: 8 }, // odklejone od dolnego przyciemnienia (scrim ~132) — chipy lekko nad paskiem
  zoomChip: { minWidth: 40, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)" },
  zoomChipOn: { backgroundColor: "rgba(255,255,255,0.92)", borderColor: "#fff" },
  zoomChipText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  zoomChipTextOn: { color: "#000" },
  side: { minWidth: 96 },
  doneText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  counter: { color: "#fff", fontSize: 15, fontWeight: "700", textAlign: "right" },
  shutter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 5,
    borderColor: "#fff",
    backgroundColor: "rgba(255,255,255,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterOff: { opacity: 0.4 },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#fff" },
  btn: { flex: 1, borderRadius: 14, paddingVertical: 16, alignItems: "center", justifyContent: "center" },
  btnGhost: { backgroundColor: "rgba(255,255,255,0.18)" },
  btnGhostText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  btnUse: { backgroundColor: colors.accent },
  btnUseText: { color: colors.buttonText, fontSize: 16, fontWeight: "800" },
  btnOff: { opacity: 0.6 },
  permWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  permText: { color: "#fff", fontSize: 16, textAlign: "center", lineHeight: 22 },
  permBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  permBtnText: { color: colors.buttonText, fontWeight: "800", fontSize: 15 },
  permClose: { paddingHorizontal: 24, paddingVertical: 10 },
  permCloseText: { color: "#fff", fontSize: 14, opacity: 0.8 },
  thumbSide: { alignItems: "flex-end" },
  thumbOuter: { width: 46, height: 58, position: "relative" }, // bez overflow:hidden — badge może wystawać
  thumbWrap: { width: 46, height: 58, borderRadius: 8, overflow: "hidden", borderWidth: 2, borderColor: "#fff" },
  thumb: { width: "100%", height: "100%" },
  thumbBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 4,
    backgroundColor: colors.accent,
    borderWidth: 1.5,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbBadgeText: { color: colors.buttonText, fontSize: 11, fontWeight: "800" },
  galleryRoot: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.96)", justifyContent: "center" },
  galleryPage: { alignItems: "center", justifyContent: "center" },
  galleryCaption: { marginTop: 16, paddingHorizontal: 24, alignItems: "center" },
  galleryIndex: { color: "#fff", fontSize: 13, fontWeight: "800", opacity: 0.8, marginBottom: 6 },
  galleryPeek: { color: "#fff", fontSize: 16, fontWeight: "700", textAlign: "center" },
  galleryClose: { position: "absolute", top: 52, right: 24 },
  galleryCloseText: { color: "#fff", fontSize: 26, fontWeight: "700" },
  galleryTopHint: { position: "absolute", top: 58, alignSelf: "center", color: "#fff", fontSize: 12, opacity: 0.7 },
  galleryDelete: {
    position: "absolute",
    bottom: 98,
    alignSelf: "center",
    backgroundColor: "rgba(179,38,30,0.9)",
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  galleryDeleteText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  stripWrap: { position: "absolute", left: 0, right: 0, bottom: 28 },
  strip: { paddingHorizontal: 12, gap: 8, alignItems: "center" },
  stripThumb: { width: 44, height: 56, borderRadius: 6, opacity: 0.5, borderWidth: 2, borderColor: "transparent" },
  stripThumbActive: { opacity: 1, borderColor: "#fff" },
});
