// Stały, dyskretny znacznik NUMERU BUILDA widoczny na KAŻDYM ekranie (overlay renderowany nad całą apką w
// index.ts). Cel: gdy wysyłasz screena, od razu widać, z którego buildu jest. Numer = natywny CFBundleVersion
// (EAS autoincrement, ten sam co w TestFlight). `pointerEvents="box-none"` → nie przechwytuje dotyku poza samym
// chipem; tap w chip chowa go na 4 s (gdyby zasłaniał coś, co chcesz dotknąć/zrzucić).
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Application from "expo-application";

export function BuildBadge() {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const build = Application.nativeBuildVersion ?? "?";
  const ver = Application.nativeApplicationVersion ?? "";
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
      <Pressable
        onPress={() => { setHidden(true); setTimeout(() => setHidden(false), 4000); }}
        style={{ position: "absolute", top: 50, right: 6, backgroundColor: "rgba(0,0,0,0.6)", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}
      >
        <Text style={{ color: "#fff", fontSize: 10, fontWeight: "800" }}>build {build}{ver ? ` · v${ver}` : ""}</Text>
      </Pressable>
    </View>
  );
}
