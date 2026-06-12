// Modal do zmiany nazwy zapisanego menu (działa na iOS i Androidzie — własne pole,
// nie Alert.prompt, który jest iOS-only).
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { colors } from "./theme";

export function RenameModal({
  visible,
  initialValue,
  title = "Nazwa menu",
  onCancel,
  onSave,
}: {
  visible: boolean;
  initialValue: string;
  title?: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const [value, setValue] = useState(initialValue);

  // Reset pola przy każdym otwarciu.
  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={styles.bg}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.box}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder="np. Cúrcuma"
            placeholderTextColor={colors.muted}
            style={styles.input}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={() => onSave(value)}
          />
          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.cancel]} onPress={onCancel}>
              <Text style={styles.cancelText}>Anuluj</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.save]} onPress={() => onSave(value)}>
              <Text style={styles.saveText}>Zapisz</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 },
  box: { backgroundColor: colors.card, borderRadius: 14, padding: 18 },
  title: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderColor: colors.badgeBg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.badgeBg,
  },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  btn: { borderRadius: 999, paddingHorizontal: 18, paddingVertical: 9 },
  cancel: { backgroundColor: colors.badgeBg },
  cancelText: { color: colors.text, fontWeight: "700", fontSize: 14 },
  save: { backgroundColor: colors.accent },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
