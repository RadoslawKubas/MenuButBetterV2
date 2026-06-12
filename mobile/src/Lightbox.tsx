// Pełnoekranowy podgląd zdjęć: swipe lewo/prawo między zdjęciami dania, swipe w GÓRĘ
// zamyka galerię. Na dole pokazujemy, SKĄD pochodzi aktualnie oglądane zdjęcie.
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  FlatList,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { sourceMeta } from "./photoSource";

export interface LightboxPhoto {
  url: string;
  source: string;
  fromVenue?: boolean;
  attribution?: string;
}

export interface LightboxState {
  photos: LightboxPhoto[];
  index: number;
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
  const translateY = useRef(new Animated.Value(0)).current;
  const bgOpacity = useRef(new Animated.Value(1)).current;

  // Reset pozycji/przezroczystości i ustaw stronę startową przy każdym otwarciu.
  useEffect(() => {
    if (state) {
      translateY.setValue(0);
      bgOpacity.setValue(1);
      setCurrent(Math.min(state.index, state.photos.length - 1));
    }
  }, [state, translateY, bgOpacity]);

  // Gest pionowy w górę → zamknij. Poziome przesuwanie zostawiamy FlatList (paginacja).
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy < -8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_, g) => {
        if (g.dy < 0) {
          translateY.setValue(g.dy);
          bgOpacity.setValue(Math.max(0.15, 1 + g.dy / 400));
        }
      },
      onPanResponderRelease: (_, g) => {
        const dismiss = g.dy < -110 || g.vy < -0.6;
        if (dismiss) {
          Animated.timing(translateY, {
            toValue: -height,
            duration: 150,
            useNativeDriver: true,
          }).start(() => onClose());
        } else {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
          Animated.spring(bgOpacity, { toValue: 1, useNativeDriver: true }).start();
        }
      },
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
          onMomentumScrollEnd={(e) =>
            setCurrent(Math.round(e.nativeEvent.contentOffset.x / width))
          }
          renderItem={({ item }) => (
            <Animated.View
              {...pan.panHandlers}
              style={[styles.page, { width, transform: [{ translateY }] }]}
            >
              <Pressable style={styles.pagePress} onPress={onClose}>
                <Image
                  source={{ uri: item.url }}
                  style={{ width: width * 0.92, height: height * 0.72 }}
                  resizeMode="contain"
                />
              </Pressable>
            </Animated.View>
          )}
        />

        <Pressable style={styles.close} onPress={onClose} hitSlop={12}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>

        {/* Skąd jest aktualnie oglądane zdjęcie. */}
        <View style={styles.infoBar} pointerEvents="none">
          {cur.fromVenue ? <Text style={styles.venueTag}>★ z tego lokalu</Text> : null}
          <View style={styles.sourceRow}>
            <View style={[styles.sourceDot, { backgroundColor: meta.color }]} />
            <Text style={styles.sourceLabel}>{meta.label}</Text>
          </View>
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
  infoBar: { position: "absolute", bottom: 36, alignSelf: "center", alignItems: "center", paddingHorizontal: 24 },
  venueTag: { color: "#f1c40f", fontSize: 13, fontWeight: "800", marginBottom: 6 },
  sourceRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  sourceDot: { width: 9, height: 9, borderRadius: 5 },
  sourceLabel: { color: "#fff", fontSize: 14, fontWeight: "700" },
  attrib: { color: "#fff", fontSize: 12, opacity: 0.6, marginTop: 3, maxWidth: 280, textAlign: "center" },
  counter: { color: "#fff", fontSize: 13, opacity: 0.75, marginTop: 8 },
});
