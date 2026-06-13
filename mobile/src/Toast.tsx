// Toast błędu API — pokazuje się, gdy któreś wywołanie naszego serwera poleci błędem
// (nawet niekrytyczne). Szczegóły i tak lądują w „Diagnostyce". Dotknij, by zamknąć.
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";
import { onApiError, classifyError, type ClientCall } from "./appLog";

export function ApiErrorToast() {
  const [err, setErr] = useState<ClientCall | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return onApiError((e) => {
      setErr(e);
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, 7000);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function hide() {
    Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => setErr(null));
  }

  if (!err) return null;
  const kind = classifyError(err.detail);
  return (
    <Animated.View style={[styles.wrap, { opacity }]} pointerEvents="box-none">
      <Pressable style={styles.toast} onPress={hide}>
        <Text style={styles.title}>
          {kind.icon} {err.label}: {kind.label}
        </Text>
        {err.detail ? (
          <Text style={styles.detail} numberOfLines={3}>
            {err.detail}
          </Text>
        ) : null}
        <Text style={styles.hint}>dotknij, by zamknąć · szczegóły w „Diagnostyka”</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 12, right: 12, bottom: 24 },
  toast: {
    backgroundColor: "#7A1F1F",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  title: { color: "#fff", fontWeight: "800", fontSize: 14 },
  detail: { color: "#fff", opacity: 0.9, fontSize: 12, marginTop: 4 },
  hint: { color: "#fff", opacity: 0.6, fontSize: 11, marginTop: 6 },
});
