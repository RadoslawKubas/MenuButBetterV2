#!/usr/bin/env bash
# Lokalny build iOS BEZ wysyłki (eas build --local). .ipa zostaje w mobile/ do RĘCZNEGO uploadu
# z ekranu 🚀 Deploy w labie — tam jest kontrola dziennego limitu wgrań Apple.
#
# Budowanie NIE zużywa limitu Apple — tylko `eas submit`. Więc buduj ile chcesz, a wgrywaj świadomie.
#
# Użycie:  cd mobile && ./build-only.sh
#
# Uwaga: NIE kasuje starych build-*.ipa (w przeciwieństwie do build-submit.sh) — lab pokazuje listę
# gotowych buildów i pozwala wybrać, który wgrać / usunąć.
set -euo pipefail

cd "$(dirname "$0")" # katalog mobile/

echo "▸ Buduję lokalnie (bez submit; numer builda podbije się sam: appVersionSource:remote + autoIncrement)…"
eas build --local --platform ios --profile production --non-interactive

IPA="$(ls -t build-*.ipa 2>/dev/null | head -1 || true)"
if [ -z "$IPA" ]; then
  echo "✗ Nie znalazłem .ipa — build się nie powiódł. Sprawdź log wyżej."
  exit 1
fi
echo "✓ Gotowy: mobile/$IPA"
echo "  → otwórz lab → zakładka 🚀 Deploy → wpisz notkę i kliknij „⬆️ Wgraj\", gdy limit Apple pozwala."
