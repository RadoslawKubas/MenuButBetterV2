#!/usr/bin/env bash
# Lokalny build iOS BEZ wysyłki (eas build --local). .ipa zostaje w mobile/ do RĘCZNEGO uploadu
# z ekranu 🚀 Deploy w labie — tam jest kontrola dziennego limitu wgrań Apple.
#
# Budowanie NIE zużywa limitu Apple — tylko `eas submit`. Więc buduj ile chcesz, a wgrywaj świadomie.
#
# Użycie:  cd mobile && ./build-only.sh ["podsumowanie co jest w tym buildzie"]
#
# Notka: PIERWSZY argument = podsumowanie buildu (co w nim jest) → zapisywane do <ipa>.note i pokazywane
# w labie/Deploy (read-only). Bez argumentu → domyślnie ostatnie tematy commitów.
#
# Uwaga: NIE kasuje starych build-*.ipa (w przeciwieństwie do build-submit.sh) — lab pokazuje listę
# gotowych buildów i pozwala wybrać, który wgrać / usunąć.
set -euo pipefail

cd "$(dirname "$0")" # katalog mobile/

NOTE="${1:-$(git log -8 --pretty='• %s')}"

# NUMER BUILDA — inkrementowany LOKALNIE w app.json (appVersionSource:local). Wcześniej był remote+autoIncrement, ale
# `eas build --local` NIE podbija zdalnego numeru → wszystkie lokalne buildy szły z tym samym numerem → Apple
# odrzucał drugi jako duplikat (redundant binary). Teraz każdy build = poprzedni+1, monotonicznie, offline, pewnie.
NEW_BUILD="$(node -e '
const fs=require("fs"); const p="./app.json"; const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.expo.ios=j.expo.ios||{};
const cur=parseInt(j.expo.ios.buildNumber||"0",10)||0; const next=cur+1;
j.expo.ios.buildNumber=String(next);
fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
process.stdout.write(String(next));
')"
echo "▸ Numer builda iOS: $NEW_BUILD (lokalny autoincrement w app.json — unikalny, monotoniczny)"

echo "▸ Buduję lokalnie (bez submit)…"
eas build --local --platform ios --profile production --non-interactive

IPA="$(ls -t build-*.ipa 2>/dev/null | head -1 || true)"
if [ -z "$IPA" ]; then
  echo "✗ Nie znalazłem .ipa — build się nie powiódł. Sprawdź log wyżej."
  exit 1
fi
printf 'build %s — %s\n' "$NEW_BUILD" "$NOTE" > "$IPA.note" # podsumowanie buildu (czyta je lab/Deploy)
echo "✓ Gotowy: mobile/$IPA  (build $NEW_BUILD, + notka w $IPA.note)"
echo "  → otwórz lab → zakładka 🚀 Deploy → kliknij „⬆️ Wgraj\", gdy limit Apple pozwala."
