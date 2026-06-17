// Własny aparat „seryjny" (expo-camera): migawka robi zdjęcie BEZ kroku „Use Photo" i
// zostaje otwarta na kolejne. „Gotowe" zamyka — wszystkie zdjęcia są już dodane do skanu.
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { MAX_IMAGES } from "./image";
import { colors } from "./theme";

export function CameraCapture({
  visible,
  count,
  onCapture,
  onClose,
}: {
  visible: boolean;
  count: number;
  onCapture: (uri: string, exif?: Record<string, unknown> | null) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  if (!visible) return null;

  const full = count >= MAX_IMAGES;

  async function shoot() {
    if (busy || full) return;
    setBusy(true);
    try {
      const photo = await ref.current?.takePictureAsync({ quality: 1, exif: true });
      if (photo?.uri) await onCapture(photo.uri, (photo.exif ?? null) as Record<string, unknown> | null);
    } catch {
      // pojedyncze nieudane zdjęcie — można pstryknąć ponownie
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {permission?.granted ? (
          <CameraView ref={ref} style={styles.camera} facing="back" />
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

        {permission?.granted ? (
          <View style={styles.bar}>
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

            <View style={styles.side}>
              <Text style={styles.counter}>{full ? "Maks." : `📸 ${count}`}</Text>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
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
    backgroundColor: "rgba(0,0,0,0.35)",
  },
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
  permWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  permText: { color: "#fff", fontSize: 16, textAlign: "center", lineHeight: 22 },
  permBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12 },
  permBtnText: { color: colors.buttonText, fontWeight: "800", fontSize: 15 },
  permClose: { paddingHorizontal: 24, paddingVertical: 10 },
  permCloseText: { color: "#fff", fontSize: 14, opacity: 0.8 },
});
