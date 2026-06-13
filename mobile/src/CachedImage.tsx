// Obrazek z lokalnego cache z bezpiecznym fallbackiem na zdalny URL.
// `uri` to zapisana referencja cache (względna „dishphotos/…", stara bezwzględna albo http).
// Składamy aktualny `file://` przez resolveCachedUri; gdy plik się nie wczyta (np. zniknął),
// przełączamy się na `remoteUrl`. Dzięki temu „puste ramki" znikają nawet po restarcie.
import { useEffect, useState } from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";
import { resolveCachedUri } from "./imageCache";

export function CachedImage({
  uri,
  remoteUrl,
  style,
}: {
  uri?: string;
  remoteUrl?: string;
  style?: StyleProp<ImageStyle>;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri, remoteUrl]);

  const local = resolveCachedUri(uri);
  const src = failed && remoteUrl ? remoteUrl : local;
  if (!src) return null;

  return <Image source={{ uri: src }} style={style} onError={() => setFailed(true)} />;
}
