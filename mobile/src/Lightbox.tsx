// Pełnoekranowy podgląd zdjęć: swipe lewo/prawo między zdjęciami dania, swipe w GÓRĘ
// zamyka galerię. Na dole pokazujemy, SKĄD pochodzi aktualnie oglądane zdjęcie.
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Linking,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Icon } from "./Icon";
import { sourceMeta } from "./photoSource";
import { resolveCachedUri } from "./imageCache";
import { detectMenuRegion, clusterGroups, type MenuRegion } from "./menuRegion";
import { MenuRegionOverlay } from "./MenuRegionOverlay";

export interface LightboxPhoto {
  url: string;
  source: string;
  fromVenue?: boolean;
  fromVenueReason?: string;
  attribution?: string;
  /** URL strony źródłowej (klikalne „źródło") + domena (nazwa strony). */
  contextUrl?: string;
  domain?: string;
  /** Dodatkowa notka pod zdjęciem (np. szybki podgląd „quick peek": kuchnia/lokal/jakość). */
  note?: string;
  /** Ocena vision 0..1 (dopasowanie do dania) — pokazywana jako %. */
  score?: number;
  /** Odrzucone przez weryfikację (słaba jakość) — oznaczone w podglądzie. */
  rejected?: boolean;
}

export interface LightboxState {
  photos: LightboxPhoto[];
  index: number;
  /** Pokaż przycisk „Zaznacz menu" (on-device OCR → prostokąt listy dań). Tylko dla migawek (zdjęcia menu). */
  allowMenuDetect?: boolean;
}

/** Nazwa strony źródłowej (host bez „www.") do pokazania przy zdjęciu. */
function sourceHost(p: LightboxPhoto): string {
  if (p.domain) return p.domain.replace(/^www\./, "");
  try { return new URL(p.contextUrl!).host.replace(/^www\./, ""); } catch { return ""; }
}

// Minimalny suwak (bez natywnej zależności): drag WZGLĘDNY (gestureState.dx), refy trzymają aktualną wartość →
// brak stale-closure. Szerokość toru stała. Touch zaczęty na suwaku trafia do niego (nie do FlatList/swipe).
function MiniSlider({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  const W = 200;
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const valueRef = useRef(value); valueRef.current = value;
  const startRef = useRef(value);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { startRef.current = valueRef.current; },
      onPanResponderMove: (_, g) => { onChange(Math.max(min, Math.min(max, startRef.current + (g.dx / W) * (max - min)))); },
    }),
  ).current;
  return (
    <View {...pan.panHandlers} style={{ width: W, height: 30, justifyContent: "center" }}>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.3)" }} />
      <View style={{ position: "absolute", left: pct * W - 9, width: 18, height: 18, borderRadius: 9, backgroundColor: "#fff", borderWidth: 2, borderColor: "rgba(0,0,0,0.3)" }} />
    </View>
  );
}

export function Lightbox({
  state,
  onClose,
}: {
  state: LightboxState | null;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [current, setCurrent] = useState(0);
  const [detected, setDetected] = useState<MenuRegion | null>(null); // prostokąt menu (OCR) dla AKTUALNEGO zdjęcia
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null); // WIDOCZNY status/błąd OCR (zamiast cichego połykania)
  const [showOverlay, setShowOverlay] = useState(true); // nakładka liczona AUTO; przycisk tylko ukrywa/pokazuje
  const [gapMult, setGapMult] = useState(1.2); // próg klastrowania grup (×medianowa wys. linii) — live suwakiem
  const translateY = useRef(new Animated.Value(0)).current;
  const bgOpacity = useRef(new Animated.Value(1)).current;
  const openedRef = useRef<LightboxState | null>(null);

  // Powrót do stanu neutralnego (gest anulowany / niewystarczający do zamknięcia).
  const resetPan = useRef(() => {
    Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
    Animated.spring(bgOpacity, { toValue: 1, useNativeDriver: true, bounciness: 0 }).start();
  }).current;

  // Reset pozycji/tła robimy PRZY OTWARCIU (synchronicznie, jeszcze przed pierwszą klatką),
  // a NIE na koniec zamykania — inaczej snap był widoczny tuż po geście. Zamknięcie zostaje
  // czyste (zdjęcie wyjeżdża w górę i znika), a kolejne otwarcie startuje od zera.
  if (state) {
    if (openedRef.current !== state) {
      openedRef.current = state;
      translateY.setValue(0);
      bgOpacity.setValue(1);
    }
  } else {
    openedRef.current = null;
  }

  // Ustaw stronę startową przy otwarciu.
  useEffect(() => {
    if (state) { setCurrent(Math.min(state.index, state.photos.length - 1)); setDetected(null); setDetectMsg(null); }
  }, [state]);

  // AUTO on-device OCR: po otwarciu i przy zmianie strony licz prostokąt/siatkę menu dla AKTUALNEGO zdjęcia
  // (bez przycisku — szybkie, on-device). Tylko migawki (allowMenuDetect). Stróż `cancelled` odsiewa spóźnione.
  useEffect(() => {
    if (!state?.allowMenuDetect) return;
    const photo = state.photos[current];
    const uri = photo ? resolveCachedUri(photo.url) : undefined;
    if (!uri) { setDetected(null); return; }
    let cancelled = false;
    setDetected(null); setDetecting(true); setDetectMsg(null);
    detectMenuRegion(uri)
      .then((r) => { if (!cancelled) { setDetected(r); setDetectMsg(r ? null : "OCR: nie wykryto tekstu na zdjęciu"); } })
      .catch((e: unknown) => { if (!cancelled) { setDetected(null); setDetectMsg("OCR błąd: " + ((e as Error)?.message ?? String(e))); } })
      .finally(() => { if (!cancelled) setDetecting(false); });
    return () => { cancelled = true; };
  }, [state, current]);

  // Gest pionowy w górę → zamknij. Poziome przesuwanie zostawiamy FlatList (paginacja).
  const pan = useRef(
    PanResponder.create({
      // Przejmujemy TYLKO wyraźny ruch w górę (pionowy dominuje nad poziomym).
      onMoveShouldSetPanResponder: (_, g) => g.dy < -10 && Math.abs(g.dy) > Math.abs(g.dx),
      // Gdy już przejęliśmy pionowy gest, NIE oddajemy go FlatList — inaczej ruch w bok
      // w trakcie machnięcia „wyrywał" gest i zostawał dziwny, połowiczny stan.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => {
        const dy = Math.min(0, g.dy); // tylko w górę
        translateY.setValue(dy);
        bgOpacity.setValue(Math.max(0.15, 1 + dy / 400));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy < -110 || g.vy < -0.6) {
          // Czyste zamknięcie: zdjęcie wyjeżdża w górę, tło gaśnie — BEZ resetu tutaj
          // (reset robimy przy następnym otwarciu, żeby snap nie był widoczny po geście).
          Animated.parallel([
            Animated.timing(translateY, { toValue: -height, duration: 180, useNativeDriver: true }),
            Animated.timing(bgOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
          ]).start(() => onClose());
        } else {
          resetPan();
        }
      },
      // Bezpiecznik: gdyby gest został przerwany (system / inny responder) — wróć do zera.
      onPanResponderTerminate: () => resetPan(),
    }),
  ).current;

  if (!state || state.photos.length === 0) return null;

  const cur = state.photos[current] ?? state.photos[0]!;
  const meta = sourceMeta(cur.source);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Animated.View style={[styles.bg, { opacity: bgOpacity }]}>
        <FlatList
          data={state.photos}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={Math.min(state.index, state.photos.length - 1)}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          keyExtractor={(_, i) => String(i)}
          onMomentumScrollEnd={(e) => setCurrent(Math.round(e.nativeEvent.contentOffset.x / width))}
          renderItem={({ item, index }) => {
            const boxW = width * 0.92, boxH = height * 0.72;
            return (
              <Animated.View
                {...pan.panHandlers}
                style={[styles.page, { width, transform: [{ translateY }] }]}
              >
                <Pressable style={styles.pagePress} onPress={onClose}>
                  <View style={{ width: boxW, height: boxH }}>
                    <Image
                      source={{ uri: resolveCachedUri(item.url) }}
                      style={{ width: boxW, height: boxH }}
                      resizeMode="contain"
                    />
                    {detected && showOverlay && index === current ? <MenuRegionOverlay region={detected} boxW={boxW} boxH={boxH} groupMult={gapMult} /> : null}
                  </View>
                </Pressable>
              </Animated.View>
            );
          }}
        />

        <Pressable style={styles.close} onPress={onClose} hitSlop={12}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>

        {/* OCR liczy się AUTOMATYCZNIE na każdym zdjęciu; przycisk tylko UKRYWA/POKAZUJE nakładkę. Tylko migawki. */}
        {state.allowMenuDetect ? (
          <Pressable style={styles.detectBtn} onPress={() => setShowOverlay((s) => !s)} disabled={detecting} hitSlop={8}>
            {detecting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.detectBtnText}>
                <Icon name="searchAlt" /> {detected ? `${detected.blocks} bl · ${detected.cols}×${detected.rows} · ${showOverlay ? "ukryj" : "pokaż"}` : "—"}
              </Text>
            )}
          </Pressable>
        ) : null}

        {/* WIDOCZNY status/błąd OCR — żeby porażka nie była niewidzialna („nic się nie dzieje"). */}
        {detectMsg ? (
          <View style={styles.detectMsg} pointerEvents="none">
            <Text style={styles.detectMsgText}>{detectMsg}</Text>
          </View>
        ) : null}

        {/* LIVE suwak progu grupowania — przelicza TYLKO klastry (bez ponownego OCR). */}
        {state.allowMenuDetect && detected ? (
          <View style={styles.sliderBar}>
            <Text style={styles.sliderLabel}>grupy · próg {gapMult.toFixed(1)} · {clusterGroups(detected, gapMult).length} grup</Text>
            <MiniSlider value={gapMult} min={0.2} max={4} onChange={setGapMult} />
          </View>
        ) : null}

        {/* Skąd jest aktualnie oglądane zdjęcie. */}
        <View style={styles.infoBar} pointerEvents="box-none">
          {cur.note ? <Text style={styles.peekNote} numberOfLines={2}>{cur.note}</Text> : null}
          {cur.fromVenue ? <Text style={styles.venueTag}>★ z tego lokalu</Text> : null}
          <View style={styles.sourceRow}>
            <View style={[styles.sourceDot, { backgroundColor: meta.color }]} />
            <Text style={styles.sourceLabel}>{meta.label}</Text>
          </View>
          {!cur.fromVenue ? (
            <Text style={styles.webDisclaimer} numberOfLines={2}>
              Zdjęcie poglądowe z sieci — może nie przedstawiać dokładnie tej potrawy.
            </Text>
          ) : null}
          {cur.contextUrl ? (
            <Pressable onPress={() => Linking.openURL(cur.contextUrl!).catch(() => {})} style={styles.sourceLinkBtn} hitSlop={8}>
              <Text style={styles.sourceLink} numberOfLines={1}><Icon name="link" /> Źródło{sourceHost(cur) ? `: ${sourceHost(cur)}` : ""} ↗</Text>
            </Pressable>
          ) : null}
          {cur.rejected || cur.score != null ? (
            <Text style={cur.rejected ? styles.rejectedTag : styles.scoreTag}>
              {cur.rejected ? "odrzucone (słaba jakość)" : "✓ trafność"}
              {cur.score != null ? ` ${Math.round(cur.score * 100)}%` : ""}
            </Text>
          ) : null}
          {cur.fromVenueReason ? (
            <Text style={styles.venueReason} numberOfLines={2}>
              {cur.fromVenue ? "✓" : "✗"} {cur.fromVenueReason}
            </Text>
          ) : null}
          {cur.attribution ? (
            <Text style={styles.attrib} numberOfLines={1}>
              {cur.attribution}
            </Text>
          ) : null}
          <Text style={styles.counter}>
            {state.photos.length > 1 ? `${current + 1} / ${state.photos.length}  ·  ` : ""}
            przesuń w górę, by zamknąć
          </Text>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", justifyContent: "center" },
  page: { alignItems: "center", justifyContent: "center" },
  pagePress: { alignItems: "center", justifyContent: "center" },
  close: { position: "absolute", top: 52, right: 24 },
  closeText: { color: "#fff", fontSize: 26, fontWeight: "700" },
  detectBtn: { position: "absolute", top: 50, left: 20, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.25)", minWidth: 130, minHeight: 34, alignItems: "center", justifyContent: "center" },
  detectBtnText: { color: "#fff", fontSize: 13, fontWeight: "800" },
  detectMsg: { position: "absolute", top: 92, left: 20, right: 20, backgroundColor: "rgba(180,40,40,0.94)", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  detectMsgText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  sliderBar: { position: "absolute", bottom: 118, alignSelf: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 12, paddingVertical: 8, paddingHorizontal: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)" },
  sliderLabel: { color: "#fff", fontSize: 12, fontWeight: "700", marginBottom: 4 },
  menuBox: { position: "absolute", borderWidth: 2.5, borderColor: "#4ade80", backgroundColor: "rgba(74,222,128,0.12)", borderRadius: 3 },
  infoBar: { position: "absolute", bottom: 36, alignSelf: "center", alignItems: "center", paddingHorizontal: 24 },
  peekNote: { color: "#fff", fontSize: 13, fontWeight: "700", marginBottom: 8, maxWidth: 320, textAlign: "center" },
  scoreTag: { color: "#7fd6a0", fontSize: 12.5, fontWeight: "700", marginTop: 5 },
  rejectedTag: { color: "#ff8a80", fontSize: 12.5, fontWeight: "800", marginTop: 5 },
  venueTag: { color: "#f1c40f", fontSize: 13, fontWeight: "800", marginBottom: 6 },
  sourceRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  sourceDot: { width: 9, height: 9, borderRadius: 5 },
  sourceLabel: { color: "#fff", fontSize: 14, fontWeight: "700" },
  webDisclaimer: { color: "#fff", opacity: 0.6, fontSize: 12, fontStyle: "italic", textAlign: "center", maxWidth: 320, marginTop: 4, lineHeight: 16 },
  sourceLinkBtn: { marginTop: 5, paddingVertical: 5, paddingHorizontal: 12, backgroundColor: "rgba(255,255,255,0.14)", borderRadius: 8, maxWidth: 300 },
  sourceLink: { color: "#9ecbff", fontSize: 13, fontWeight: "700" },
  attrib: { color: "#fff", fontSize: 12, opacity: 0.6, marginTop: 3, maxWidth: 280, textAlign: "center" },
  venueReason: { color: "#fff", fontSize: 11, opacity: 0.7, marginTop: 5, maxWidth: 300, textAlign: "center" },
  counter: { color: "#fff", fontSize: 13, opacity: 0.75, marginTop: 8 },
});
