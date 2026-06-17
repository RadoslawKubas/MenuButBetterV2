// Własny aparat: migawka robi zdjęcie i pokazuje je ZAMROŻONE (podgląd „Użyj / Ponów").
//  • „✓ Użyj"  → dodaje zdjęcie i WRACA do aparatu (nie zamyka) — można robić serię.
//  • „↺ Ponów" → odrzuca i wraca do aparatu.
//  • „Gotowe (N)" → zamyka; wszystkie użyte zdjęcia są już dodane do skanu.
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { MAX_IMAGES } from "./image";
import type { PeekResult } from "./api";
import { colors } from "./theme";

type Pending = { uri: string; exif: Record<string, unknown> | null };

// Tekst bannera „szybkiego podglądu".
function peekText(info: PeekResult | null): string {
  if (!info) return "podgląd gotowy — pstryknij zdjęcie";
  if (!info.isMenu) return "⚠️ to nie wygląda na menu";
  const parts = [info.cuisine ? `🍽️ ${info.cuisine}` : "", info.restaurantName ? `📍 ${info.restaurantName}` : ""].filter(Boolean);
  return parts.length ? parts.join("  ·  ") : "✓ wygląda na menu";
}

export function CameraCapture({
  visible,
  count,
  onCapture,
  onClose,
  peekEnabled,
  onTogglePeek,
  peekInfo,
  peeking,
}: {
  visible: boolean;
  count: number;
  onCapture: (uri: string, exif?: Record<string, unknown> | null) => Promise<void>;
  onClose: () => void;
  peekEnabled: boolean;
  onTogglePeek: (on: boolean) => void;
  peekInfo: PeekResult | null;
  peeking: boolean;
}) {
  const ref = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false); // robienie zdjęcia
  const [saving, setSaving] = useState(false); // przetwarzanie „Użyj"
  const [pending, setPending] = useState<Pending | null>(null); // zamrożony podgląd

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
    }
  }, [visible]);

  if (!visible) return null;

  const full = count >= MAX_IMAGES;

  async function shoot() {
    if (busy || full || pending) return;
    setBusy(true);
    try {
      const photo = await ref.current?.takePictureAsync({ quality: 1, exif: true });
      if (photo?.uri) setPending({ uri: photo.uri, exif: (photo.exif ?? null) as Record<string, unknown> | null });
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
            <CameraView ref={ref} style={styles.camera} facing="back" />

            {/* Zamrożony podgląd ostatniego zdjęcia. */}
            {pending ? (
              <Image source={{ uri: pending.uri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
            ) : null}

            {/* Górny pasek: przełącznik „szybkiego podglądu" + banner z kontekstem. */}
            <View style={styles.topBar}>
              <Pressable
                style={[styles.peekToggle, peekEnabled && styles.peekToggleOn]}
                onPress={() => onTogglePeek(!peekEnabled)}
              >
                <Text style={styles.peekToggleText}>🔎 {peekEnabled ? "Podgląd wł." : "Podgląd wył."}</Text>
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
              // Pasek aparatu: Gotowe / migawka / licznik.
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
});
